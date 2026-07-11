/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts a Float32Array from browser mic audio channel data into PCM 16-bit little-endian base64 string
 */
export function float32ToPcm16Base64(float32Array: Float32Array): string {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp to standard floating range
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    // Convert to signed 16-bit integer
    const pcm = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, pcm, true); // true for little-endian
  }
  
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a raw base64 PCM 16-bit little-endian string (Gemini output) to a Float32Array for Web Audio API
 */
export function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  
  return float32Array;
}
