/**
 * Claude's voice on the dashboard: Kokoro-82M, a small text-to-speech model, run locally
 * with kokoro-js on the same ONNX runtime as semantic search. No account, no API key, and
 * nothing leaves the computer. The model (~290 MB) downloads into the model cache the first
 * time a voice is used. It's speech synthesis, not an LLM, so SPEC §2.1 still holds.
 */
import { cpus } from "node:os";
import { join } from "node:path";
import { cacheRoot } from "../config.js";

export interface Voice { id: string; name: string; description: string }

/** British voices for a "Jarvis" style assistant. */
export const VOICES: Voice[] = [
  { id: "bm_fable", name: "Fable", description: "British male, deep and calm" },
  { id: "bf_emma", name: "Emma", description: "British female, warm and clear" },
];
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MAX_CHARS = 600;

type Kokoro = { generate(text: string, o: { voice: string; speed?: number }): Promise<{ audio: Float32Array; sampling_rate: number }> };
let model: Promise<Kokoro> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Whether kokoro-js is installed (it's an optional dependency). */
export async function ttsAvailable(): Promise<boolean> {
  try { await import("kokoro-js"); return true; } catch { return false; }
}

function load(): Promise<Kokoro> {
  model ??= (async () => {
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = join(cacheRoot(), "models");
    const { KokoroTTS } = await import("kokoro-js");
    // q4 is the fastest on CPU (about real time); q8 is three times slower despite being smaller.
    // Using every core is ~25% faster than the runtime's default thread count.
    const session_options = { intraOpNumThreads: Math.max(1, cpus().length), interOpNumThreads: 1 };
    return (await KokoroTTS.from_pretrained(MODEL, { dtype: "q4", device: "cpu", session_options } as never)) as unknown as Kokoro;
  })();
  model.catch(() => { model = null; }); // let a later request retry (e.g. after going online)
  return model;
}

/** Starts loading (and if needed downloading) the model, so the first sentence isn't slow. */
export function warmUp(): void { load().catch(() => {}); }
export const ttsLoaded = () => model !== null;

/** 16-bit mono PCM WAV from Kokoro's float samples. */
export function toWav(samples: Float32Array, rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return buf;
}

/** Speaks `text` as WAV. Requests run one at a time (one model, one CPU). */
export function synthesize(text: string, voice: string): Promise<Buffer> {
  const id = VOICES.some((v) => v.id === voice) ? voice : VOICES[0]!.id;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  if (!clean) return Promise.reject(new Error("Nothing to say"));
  const run = queue.then(async () => {
    const tts = await load();
    const out = await tts.generate(clean, { voice: id });
    return toWav(out.audio, out.sampling_rate);
  });
  queue = run.catch(() => {});
  return run;
}
