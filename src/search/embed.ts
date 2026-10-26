import { createHash } from "node:crypto";
import { join } from "node:path";
import { cacheRoot, loadConfig } from "../config.js";

/** Turns text into unit-length vectors. */
export interface Embedder {
  /** Identifies the model; stored with each vector so switching models re-embeds. */
  readonly id: string;
  readonly dims: number;
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

interface ModelInfo {
  dims: number;
  queryPrefix?: string;
  passagePrefix?: string;
}

/** Known models. Others work too; dims are read from the first output. */
const MODELS: Record<string, ModelInfo> = {
  "Xenova/all-MiniLM-L6-v2": { dims: 384 },
  "Xenova/bge-small-en-v1.5": { dims: 384, queryPrefix: "Represent this sentence for searching relevant passages: " },
  "Xenova/multilingual-e5-small": { dims: 384, queryPrefix: "query: ", passagePrefix: "passage: " },
};

export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

type FeaturePipeline = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * Local embeddings via transformers.js (ONNX runtime, CPU). The model (~23 MB
 * quantised) is downloaded from Hugging Face on first use and cached in
 * ~/.cache/shannote/models. Nothing leaves the machine after that.
 */
export class TransformersEmbedder implements Embedder {
  readonly id: string;
  dims: number;
  private pipe: Promise<FeaturePipeline> | null = null;
  private info: ModelInfo;

  constructor(
    readonly model = DEFAULT_MODEL,
    private opts: { localModelPath?: string; dtype?: string } = {},
  ) {
    this.info = MODELS[model] ?? { dims: 0 };
    this.dims = this.info.dims;
    this.id = model;
  }

  private load(): Promise<FeaturePipeline> {
    this.pipe ??= (async () => {
      let mod: typeof import("@huggingface/transformers");
      try {
        mod = await import("@huggingface/transformers");
      } catch {
        throw new Error(
          "Semantic search needs the optional package @huggingface/transformers. Run `npm install` in the shannote folder.",
        );
      }
      mod.env.cacheDir = join(cacheRoot(), "models");
      if (this.opts.localModelPath) {
        mod.env.localModelPath = this.opts.localModelPath;
        mod.env.allowRemoteModels = false;
      }
      const p = await mod.pipeline("feature-extraction", this.model, {
        dtype: (this.opts.dtype ?? "q8") as "q8",
      });
      return p as unknown as FeaturePipeline;
    })();
    this.pipe.catch(() => (this.pipe = null)); // allow retry after a failed download
    return this.pipe;
  }

  async embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const pipe = await this.load();
    const prefix = kind === "query" ? this.info.queryPrefix : this.info.passagePrefix;
    const input = prefix ? texts.map((t) => prefix + t) : texts;
    const out = (await pipe(input, { pooling: "mean", normalize: true })).tolist();
    const vecs = out.map((v) => Float32Array.from(v));
    if (!this.dims && vecs[0]) this.dims = vecs[0].length;
    return vecs;
  }
}

/**
 * Deterministic bag-of-words embedder for tests. It captures word overlap, not
 * meaning, so tests check plumbing rather than search quality.
 */
export class HashEmbedder implements Embedder {
  readonly id = "test-hash";
  readonly dims = 256;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const stem = w.replace(/(ing|ed|es|s)$/, "");
        const h = createHash("md5").update(stem).digest();
        v[h.readUInt16LE(0) % this.dims]! += 1;
      }
      return normalise(v);
    });
  }
}

export function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/**
 * Embedder from environment/config, or null when semantic search is turned off.
 *   BRAIN_EMBEDDINGS=off      disable
 *   BRAIN_EMBED_MODEL         model id (default all-MiniLM-L6-v2), or config.embeddingModel
 *   BRAIN_MODEL_PATH          load models from a local folder only (no downloads)
 *   BRAIN_EMBED_DTYPE         q8 (default), fp32, fp16 …
 */
export function embedderFromEnv(): Embedder | null {
  if (/^(off|0|false|no)$/i.test(process.env.BRAIN_EMBEDDINGS ?? "")) return null;
  const cfg = loadConfig() as { embeddingModel?: string };
  return new TransformersEmbedder(process.env.BRAIN_EMBED_MODEL ?? cfg.embeddingModel ?? DEFAULT_MODEL, {
    localModelPath: process.env.BRAIN_MODEL_PATH,
    dtype: process.env.BRAIN_EMBED_DTYPE,
  });
}
