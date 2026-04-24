import { config } from './src/config';

function testLogic() {
    const cashBalance = 0; // Simulate the actual case where cash balance is failing
    const totalEquity = 500;
    const maxMarketUSDC = totalEquity * 0.15; // 75
    const currentExposureUSDC = 0;
    const availableExposureUSDC = Math.max(maxMarketUSDC - currentExposureUSDC, 0); // 75
    
    // We fixed this: targetSizeUSDC used to be 0 because it was bounded by availableExposure (which was correct)
    // But wait, if cashBalance is 0, targetSizeUSDC is 0. 
    // And baseTargetSize is 0. 
    // But minRequiredSize is forced to 5. 
    // So layers[0].size = 5.
    
    const midPrice = 0.50;
    const currentLayerSize = 5;
    
    const layerBuyYesCostUSDC = currentLayerSize * midPrice; // 2.5
    const layerBuyNoCostUSDC = currentLayerSize * (1 - midPrice); // 2.5
    const epsilon = 0.05;
    const isHardStopTriggered = false;
    const isExposureMaxedOut = false;
    
    const canIncreaseExposure = !isHardStopTriggered && !isExposureMaxedOut && 
                                (layerBuyYesCostUSDC <= availableExposureUSDC + epsilon) && 
                                (layerBuyNoCostUSDC <= availableExposureUSDC + epsilon) &&
                                (Math.max(layerBuyYesCostUSDC, layerBuyNoCostUSDC) <= cashBalance + epsilon);
                                
    console.log(`cashBalance=${cashBalance}, canIncrease=${canIncreaseExposure}`);
    console.log(`Reason for fail: maxCost(${Math.max(layerBuyYesCostUSDC, layerBuyNoCostUSDC)}) <= cash(${cashBalance}) + eps(${epsilon}) => ${Math.max(layerBuyYesCostUSDC, layerBuyNoCostUSDC) <= cashBalance + epsilon}`);
}
testLogic();