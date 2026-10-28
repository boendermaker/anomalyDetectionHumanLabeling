// Lädt tfjs-node als Mock, wenn die native Library nicht verfügbar ist.
// Nur die Logik-Methoden (buildTimelines/buildSequences/computeStats) werden
// getestet — alle werden ohne tf aufgerufen. buildModel/fit/predict sind daher
// No-Op-Platzhalter.
import { registerHooks } from 'node:module';

const MOCK_SOURCE = `
class Layer {
    constructor(config = {}) { this.config = config; }
}
export const layers = {
    LSTM: class extends Layer {},
    Dense: class extends Layer {},
    RepeatVector: class extends Layer { constructor(n) { super({ n }); } },
    TimeDistributed: class extends Layer { constructor(config) { super(config); } }
};
export const Model = class {
    constructor(config) { this.config = config; }
    compile() {}
    fit() { return { history: { loss: [0] } }; }
    predict() { return null; }
};
export const Adam = class { constructor(lr) { this.lr = lr; } };
export const meanSquaredError = () => 'mse';
export const tensor3d = (d) => d;
export const saveModel = async () => ({});
export const loadModel = async () => ({ predict: async () => null });
`;

registerHooks({
    load(url, context, nextLoad) {
        if (url.includes('@tensorflow/tfjs-node')) {
            return { format: 'module', shortCircuit: true, source: MOCK_SOURCE };
        }
        return nextLoad(url, context);
    }
});
