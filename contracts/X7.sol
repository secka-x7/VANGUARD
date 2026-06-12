// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IAavePool {
    function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external;
    function liquidationCall(address, address, address, uint256, bool) external;
}

interface ICompound {
    function isLiquidatable(address) external view returns (bool);
    function absorb(address, address[] calldata) external;
    function buyCollateral(address, uint256, uint256, address) external;
    function quoteCollateral(address, uint256) external view returns (uint256);
}

interface IMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }
    function flashLoan(address, uint256, bytes calldata) external;
    function liquidate(MarketParams calldata, address, uint256, uint256, bytes calldata) external returns (uint256, uint256);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

contract X7 {
    address public immutable owner;
    address public immutable aavePool;
    address public immutable router;
    address public immutable usdc;
    uint256 private _lock = 1;

    modifier nonReentrant() { require(_lock == 1, "X7:reentrant"); _lock = 2; _; _lock = 1; }
    modifier onlyOwner() { require(msg.sender == owner, "X7:auth"); _; }

    constructor(address _aavePool, address _router, address _usdc) {
        owner    = msg.sender;
        aavePool = _aavePool;
        router   = _router;
        usdc     = _usdc;
    }

    // Aave V3 liquidation via flash loan
    function aaveLiquidate(
        address debtAsset, uint256 debtAmount,
        address collateral, address borrower, uint24 fee
    ) external nonReentrant onlyOwner {
        bytes memory p = abi.encode(collateral, borrower, fee, uint8(0));
        IAavePool(aavePool).flashLoanSimple(address(this), debtAsset, debtAmount, p, 0);
    }

    // Aave flash loan callback
    function executeOperation(
        address asset, uint256 amount, uint256 premium,
        address initiator, bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool && initiator == address(this), "X7:bad");
        (address collateral, address borrower, uint24 fee,) =
            abi.decode(params, (address, address, uint24, uint8));

        IERC20(asset).approve(aavePool, amount + premium);
        IAavePool(aavePool).liquidationCall(collateral, asset, borrower, type(uint256).max, false);

        uint256 collBal = IERC20(collateral).balanceOf(address(this));
        if (collateral != usdc && collBal > 0) {
            IERC20(collateral).approve(router, collBal);
            ISwapRouter(router).exactInputSingle(ISwapRouter.ExactInputSingleParams({
                tokenIn: collateral, tokenOut: usdc, fee: fee,
                recipient: address(this), amountIn: collBal,
                amountOutMinimum: 0, sqrtPriceLimitX96: 0
            }));
        }

        // ETH chains: tip the builder from profit
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            uint256 tip = ethBal * 80 / 100;
            block.coinbase.call{value: tip}("");
        }

        uint256 profit = IERC20(usdc).balanceOf(address(this));
        if (profit > 0) IERC20(usdc).transfer(owner, profit);
        return true;
    }

    // Compound V3 liquidation (no flash loan needed — absorb is free)
    function compoundLiquidate(
        address comet, address borrower,
        address collateralAsset, uint24 swapFee
    ) external nonReentrant onlyOwner {
        address[] memory accounts = new address[](1);
        accounts[0] = borrower;
        ICompound(comet).absorb(address(this), accounts);

        uint256 collBal = IERC20(collateralAsset).balanceOf(address(this));
        if (collBal > 0 && collateralAsset != usdc) {
            IERC20(collateralAsset).approve(router, collBal);
            ISwapRouter(router).exactInputSingle(ISwapRouter.ExactInputSingleParams({
                tokenIn: collateralAsset, tokenOut: usdc, fee: swapFee,
                recipient: owner, amountIn: collBal,
                amountOutMinimum: 0, sqrtPriceLimitX96: 0
            }));
        } else if (collBal > 0) {
            IERC20(usdc).transfer(owner, collBal);
        }
    }

    // Morpho Blue liquidation
    function morphoLiquidate(
        address morpho, address loanToken, address collToken,
        address oracle, address irm, uint256 lltv,
        address borrower, uint256 seizeAssets, uint24 swapFee
    ) external nonReentrant onlyOwner {
        IMorpho.MarketParams memory mp = IMorpho.MarketParams({
            loanToken: loanToken, collateralToken: collToken,
            oracle: oracle, irm: irm, lltv: lltv
        });
        IMorpho(morpho).liquidate(mp, borrower, seizeAssets, 0, bytes(""));

        uint256 collBal = IERC20(collToken).balanceOf(address(this));
        if (collBal > 0 && collToken != usdc) {
            IERC20(collToken).approve(router, collBal);
            ISwapRouter(router).exactInputSingle(ISwapRouter.ExactInputSingleParams({
                tokenIn: collToken, tokenOut: usdc, fee: swapFee,
                recipient: owner, amountIn: collBal,
                amountOutMinimum: 0, sqrtPriceLimitX96: 0
            }));
        } else if (collBal > 0) {
            IERC20(usdc).transfer(owner, collBal);
        }
    }

    function rescue(address token) external onlyOwner {
        uint256 b = IERC20(token).balanceOf(address(this));
        if (b > 0) IERC20(token).transfer(owner, b);
    }

    receive() external payable {}
}
