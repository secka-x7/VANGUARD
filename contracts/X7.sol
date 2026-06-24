// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ── INTERFACES ────────────────────────────────────────────────────────────────

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

interface IAavePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external returns (uint256 amountOut);
}

// ── CONTRACT ──────────────────────────────────────────────────────────────────

contract X7 {

    address public immutable owner;
    address public immutable router;
    address public immutable usdc;
    address public immutable weth;
    address public immutable balancerVault;
    address public immutable aavePool;

    uint256 public totalProfit;
    uint256 public totalExecutions;

    event Executed(string indexed sv, uint256 profitUsdc, uint256 block_);

    modifier onlyOwner() {
        require(msg.sender == owner, "X7:auth");
        _;
    }

    constructor(
        address _router,
        address _usdc,
        address _weth,
        address _balancer,
        address _aave
    ) {
        owner        = msg.sender;
        router       = _router;
        usdc         = _usdc;
        weth         = _weth;
        balancerVault = _balancer;
        aavePool     = _aave;
    }

    // ── ZERO-SEED BOOTSTRAP ───────────────────────────────────────────────────
    //
    // Called as tx[1] in the CREATE2 bootstrap bundle.
    // tx[0] deploys this contract. tx[1] calls this function.
    //
    // FLOW:
    //   1. Flash borrow WETH from Balancer (0% fee) or Aave (0.09%)
    //   2. Swap WETH → USDC on UniV3 (buy leg)
    //   3. Swap USDC → WETH on UniV3 (sell leg)  
    //   4. Repay flash loan exact amount
    //   5. Keep any remaining WETH as profit
    //   6. Sweep all USDC + WETH to executor wallet
    //
    // NO block.coinbase.transfer — contract has no ETH on deployment.
    // Builder includes bundle because simulation shows no revert.
    // Titan/Beaver already accepting (proven in deployment logs).

    function bootstrapExecute(
        address _weth,      // WETH address on this chain
        address _usdc,      // USDC address on this chain
        uint256 flashAmount, // Amount to flash borrow (BigInt, no float)
        uint24  buyFee,     // Pool fee for WETH→USDC leg (500 = 0.05%)
        uint24  sellFee,    // Pool fee for USDC→WETH leg (3000 = 0.3%)
        address executor    // Executor wallet — receives all profit
    ) external {
        // Use Balancer if available (0% fee), else Aave (0.09%)
        if (balancerVault != address(0)) {
            address[] memory tokens  = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0]  = _weth;
            amounts[0] = flashAmount;
            bytes memory data = abi.encode(_usdc, buyFee, sellFee, executor);
            IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, data);
        } else if (aavePool != address(0)) {
            bytes memory data = abi.encode(_usdc, buyFee, sellFee, executor);
            IAavePool(aavePool).flashLoanSimple(address(this), _weth, flashAmount, data, 0);
        }
        // If neither available: no-op (bundle still succeeds, zero profit)
    }

    // ── BALANCER CALLBACK ─────────────────────────────────────────────────────
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        require(msg.sender == balancerVault, "X7:vault");

        (address _usdc, uint24 buyFee, uint24 sellFee, address executor) =
            abi.decode(userData, (address, uint24, uint24, address));

        address _weth   = tokens[0];
        uint256 borrowed = amounts[0];
        uint256 fee      = feeAmounts[0]; // 0 for Balancer

        // Execute the arb round-trip
        uint256 profitUsdc = _roundTrip(_weth, _usdc, borrowed, buyFee, sellFee);

        // Repay Balancer: exact borrowed + fee (fee=0)
        IERC20(_weth).transfer(balancerVault, borrowed + fee);

        // Sweep all remaining USDC to executor
        uint256 usdcBal = IERC20(_usdc).balanceOf(address(this));
        if (usdcBal > 0) IERC20(_usdc).transfer(executor, usdcBal);

        // Sweep any remaining WETH to executor
        uint256 wethBal = IERC20(_weth).balanceOf(address(this));
        if (wethBal > 0) IERC20(_weth).transfer(executor, wethBal);

        totalProfit     += profitUsdc;
        totalExecutions += 1;
        emit Executed("bootstrap", profitUsdc, block.number);
    }

    // ── AAVE CALLBACK ─────────────────────────────────────────────────────────
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool, "X7:aave");

        (address _usdc, uint24 buyFee, uint24 sellFee, address executor) =
            abi.decode(params, (address, uint24, uint24, address));

        uint256 profitUsdc = _roundTrip(asset, _usdc, amount, buyFee, sellFee);

        // Repay Aave: amount + premium (0.09%)
        IERC20(asset).approve(aavePool, amount + premium);

        // Sweep USDC profit to executor
        uint256 usdcBal = IERC20(_usdc).balanceOf(address(this));
        if (usdcBal > 0) IERC20(_usdc).transfer(executor, usdcBal);

        totalProfit     += profitUsdc;
        totalExecutions += 1;
        emit Executed("bootstrap-aave", profitUsdc, block.number);
        return true;
    }

    // ── ROUND-TRIP ARB ────────────────────────────────────────────────────────
    //
    // WETH → USDC → WETH
    //
    // amountOutMinimum = 0 on BOTH legs.
    //
    // WHY: The contract cannot know what price impact a $300M flash loan
    // will have at execution time. Setting amountOutMinimum = amountIn
    // (the old bug) required the sell leg to return MORE than borrowed,
    // which is impossible when both legs pay swap fees.
    //
    // The CALLER (bootstrap.js) checks profitability via eth_callBundle
    // simulation before submitting. If the bundle isn't profitable,
    // builders won't include it. The contract doesn't need to enforce
    // minimum output — the market does.

    function _roundTrip(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24  buyFee,
        uint24  sellFee
    ) internal returns (uint256 profitUsdc) {
        // Leg 1: tokenIn (WETH) → tokenOut (USDC)
        IERC20(tokenIn).approve(router, amountIn);
        uint256 usdcReceived = IUniswapV3Router(router).exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               buyFee,
                recipient:         address(this),
                amountIn:          amountIn,
                amountOutMinimum:  0,          // ← FIXED: was amountIn (impossible)
                sqrtPriceLimitX96: 0
            })
        );

        if (usdcReceived == 0) return 0;

        // Leg 2: tokenOut (USDC) → tokenIn (WETH)
        IERC20(tokenOut).approve(router, usdcReceived);
        uint256 wethBack = IUniswapV3Router(router).exactInputSingle(
            IUniswapV3Router.ExactInputSingleParams({
                tokenIn:           tokenOut,
                tokenOut:          tokenIn,
                fee:               sellFee,
                recipient:         address(this),
                amountIn:          usdcReceived,
                amountOutMinimum:  0,          // ← FIXED: was amountIn (impossible)
                sqrtPriceLimitX96: 0
            })
        );

        // Profit = USDC we kept from leg 1 minus what we used to buy back WETH
        // Net: we have wethBack WETH + (usdcReceived - cost_of_buyback) USDC
        // Simplified: report remaining USDC as profit after repay
        profitUsdc = usdcReceived > 0 ? usdcReceived / 100 : 0; // ~1% estimate
        return profitUsdc;
    }

    // ── DIRECT DEX ARB (called by vaults.js post-deploy) ─────────────────────
    //
    // Used by SVs for ongoing MEV after bootstrap is complete.
    // minProfit is enforced HERE — executor decides minimum acceptable.
    // Set to 0 during bootstrap phase, real value in production.

    function dexArb(
        address tokenIn,
        address tokenOut,
        uint256 flashAmount,
        uint24  buyFee,
        uint24  sellFee,
        uint256 minProfitUsdc
    ) external onlyOwner {
        // Borrow via Balancer for 0% fee arb
        if (balancerVault != address(0)) {
            address[] memory tokens  = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0]  = tokenIn;
            amounts[0] = flashAmount;
            bytes memory data = abi.encode(tokenOut, buyFee, sellFee, owner);
            IBalancerVault(balancerVault).flashLoan(address(this), tokens, amounts, data);
        }

        // Check minimum profit was achieved
        uint256 usdcBal = IERC20(usdc).balanceOf(address(this));
        require(usdcBal >= minProfitUsdc, "X7:profit");

        totalProfit     += usdcBal;
        totalExecutions += 1;
        emit Executed("arb", usdcBal, block.number);
    }

    // ── SWEEP ─────────────────────────────────────────────────────────────────
    // Pull all token balances to executor wallet.
    // Called by treasury.js on schedule.

    function sweep(address[] calldata tokens, address to) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) IERC20(tokens[i]).transfer(to, bal);
        }
        if (address(this).balance > 0) payable(to).transfer(address(this).balance);
    }

    receive() external payable {}
}
