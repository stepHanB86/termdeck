// Mikrofon-Samples aus dem Audio-Thread an die Seite schicken (für Aufnahme + Pegel)
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('termdeck-capture', Capture);
