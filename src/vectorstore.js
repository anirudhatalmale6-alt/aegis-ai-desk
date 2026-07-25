// Lightweight persistent vector store (the "never forgets" memory).
// In production this maps 1:1 to a managed vector DB (Qdrant / Pinecone) - same
// upsert/search interface. Here it persists to a JSON file so the POC keeps its
// memory across restarts with zero infrastructure.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { embedder, cosineSparse } from './embeddings.js';

export class VectorStore {
  constructor(path) {
    this.path = path;
    this.records = []; // { id, text, metadata, vec(serialized as entries) }
    this._load();
  }

  _load() {
    if (existsSync(this.path)) {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      this.records = raw.map(r => ({ ...r, vec: new Map(r.vec) }));
      // Rebuild the IDF corpus stats from what we already know.
      for (const r of this.records) embedder.index(r.text);
    }
  }

  _persist() {
    const serial = this.records.map(r => ({ ...r, vec: [...r.vec] }));
    writeFileSync(this.path, JSON.stringify(serial, null, 2));
  }

  upsert(id, text, metadata = {}) {
    embedder.index(text);
    const vec = embedder.embed(text);
    const existing = this.records.find(r => r.id === id);
    if (existing) {
      existing.text = text;
      existing.metadata = metadata;
      existing.vec = vec;
    } else {
      this.records.push({ id, text, metadata, vec });
    }
    // Re-embed everything so weights reflect the updated corpus IDF.
    for (const r of this.records) r.vec = embedder.embed(r.text);
    this._persist();
  }

  search(query, topK = 3) {
    const qv = embedder.embed(query);
    return this.records
      .map(r => ({ id: r.id, text: r.text, metadata: r.metadata, score: cosineSparse(qv, r.vec) }))
      .filter(r => r.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  all() {
    return this.records.map(({ id, text, metadata }) => ({ id, text, metadata }));
  }

  size() {
    return this.records.length;
  }
}
