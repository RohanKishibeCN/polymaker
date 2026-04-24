import { config } from './src/config';

function testLogic() {
    const isHardStopTriggered = false;
    const isExposureMaxedOut = false;
    const midPrice = 0.500;
    const totalEquity = 500;
    const maxMarketUSDC = totalEquity * 0.15; // 75
    const currentExposureUSDC = 0;
    const availableExposureUSDC = Math.max(maxMarketUSDC - currentExposureUSDC, 0); // 75
    const cashBalance = 500;
    
    const targetSizeUSDC = Math.min(cashBalance * 0.05, availableExposureUSDC); // 25
    let baseTargetSize = Math.floor(targetSizeUSDC / Math.max(midPrice, 0.01)); // 50
    let minRequiredSize = Math.max(baseTargetSize, 5); // 50
    const minSizeFor1USD = Math.ceil(1.00 / Math.max(midPrice, 0.01)); // 2
    minRequiredSize = Math.max(minRequiredSize, minSizeFor1USD); // 50
    
    // Test Layer logic
    const layers = [{ size: 5, spreadMult: 1.0 }]; // Simulate size 5 from logs
    
    for (const layer of layers) {
      const currentLayerSize = layer.size;
      const epsilon = 0.0001;
      const layerBuyYesCostUSDC = currentLayerSize * midPrice; // 5 * 0.5 = 2.5
      const layerBuyNoCostUSDC = currentLayerSize * (1 - midPrice); // 5 * 0.5 = 2.5
      
      const canIncreaseExposure = !isHardStopTriggered && !isExposureMaxedOut && 
                                  (layerBuyYesCostUSDC <= availableExposureUSDC + epsilon) && 
                                  (layerBuyNoCostUSDC <= availableExposureUSDC + epsilon) &&
                                  (Math.max(layerBuyYesCostUSDC, layerBuyNoCostUSDC) <= cashBalance + epsilon);
      
      console.log(`Layer size: ${currentLayerSize}`);
      console.log(`buyYesCostUSDC: ${layerBuyYesCostUSDC}`);
      console.log(`buyNoCostUSDC: ${layerBuyNoCostUSDC}`);
      console.log(`availableExposureUSDC: ${availableExposureUSDC}`);
      console.log(`cashBalance: ${cashBalance}`);
      console.log(`canIncreaseExposure: ${canIncreaseExposure}`);
    }
}
testLogic();
