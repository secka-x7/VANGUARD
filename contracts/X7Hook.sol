// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Uniswap V4 Hook — structural fee on every swap through hooked pools
// Deployed once per pool, earns 0.01% on all volume permanently

interface IPoolManager {
    struct PoolKey {
        address currency0; address currency1;
        uint24 fee; int24 tickSpacing; address hooks;
    }
    struct SwapParams {
        bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96;
    }
    struct BalanceDelta { int128 amount0; int128 amount1; }
}

contract X7Hook {
    address public immutable owner;
    address public immutable poolManager;
    uint256 public constant HOOK_FEE_BPS = 1; // 0.01% on all swaps
    uint256 public totalFees;

    event FeeCollected(uint256 amount, address token);

    // Hook permission flags (Uniswap V4 standard)
    uint160 public constant AFTER_SWAP_FLAG = 1 << 7;

    constructor(address _poolManager) {
        owner = msg.sender;
        poolManager = _poolManager;
    }

    // Called by PoolManager after every swap
    function afterSwap(
        address, // sender
        IPoolManager.PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        IPoolManager.BalanceDelta calldata delta,
        bytes calldata
    ) external returns (bytes4, int128) {
        require(msg.sender == poolManager, "!pm");
        // Calculate hook fee from swap output
        int128 output = params.zeroForOne ? delta.amount1 : delta.amount0;
        if (output < 0) output = -output;
        int128 fee = int128(uint128(uint128(output) * HOOK_FEE_BPS / 10000));
        totalFees += uint128(fee);
        emit FeeCollected(uint128(fee), params.zeroForOne ? key.currency1 : key.currency0);
        return (this.afterSwap.selector, fee);
    }

    function getHookPermissions() external pure returns (uint160) {
        return AFTER_SWAP_FLAG;
    }

    function withdraw(address token, address to) external {
        require(msg.sender == owner, "!owner");
        (bool ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, type(uint256).max));
        ok;
    }
}
