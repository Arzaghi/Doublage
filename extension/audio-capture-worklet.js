/* global AudioWorkletProcessor, registerProcessor */

// Runs on the Web Audio rendering thread. The output is deliberately silent;
// the input is forwarded to offscreen.js for PCM16 encoding and streaming.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Send roughly 256 ms at 16 kHz, matching the previous 4096-frame
    // ScriptProcessor cadence without posting a message every render quantum.
    this.chunk = new Float32Array(4096);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0];

    if (input?.length) {
      let sourceOffset = 0;
      while (sourceOffset < input.length) {
        const copied = Math.min(input.length - sourceOffset, this.chunk.length - this.offset);
        this.chunk.set(input.subarray(sourceOffset, sourceOffset + copied), this.offset);
        this.offset += copied;
        sourceOffset += copied;

        if (this.offset === this.chunk.length) {
          const samples = this.chunk;
          this.chunk = new Float32Array(samples.length);
          this.offset = 0;
          this.port.postMessage(samples, [samples.buffer]);
        }
      }
    }

    for (const channel of output) channel.fill(0);
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
