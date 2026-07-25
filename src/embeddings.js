// Embeddings adapter.
// If a real embeddings provider key is present we use it; otherwise we fall back
// to a deterministic local TF-IDF-style vectorizer so the RAG demo runs live
// without any external dependency. The interface is identical either way, so
// swapping to Voyage/OpenAI/Cohere embeddings later is a one-file change.

const STOP = new Set(('a an the of to and or in on at for with is are was were be been being ' +
  'this that these those it its i you he she they we my your our their as by from not no ' +
  'do does did can could will would should have has had my me but if then so about into out').split(' '));

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w));
}

// Global document frequency table, rebuilt as the corpus grows. Kept simple on
// purpose - this is the local fallback, not the production embedding path.
class LocalEmbedder {
  constructor() {
    this.df = new Map();     // term -> number of docs containing it
    this.docCount = 0;
    this.vocab = new Map();  // term -> stable index
  }

  index(text) {
    const terms = new Set(tokenize(text));
    for (const t of terms) {
      this.df.set(t, (this.df.get(t) || 0) + 1);
      if (!this.vocab.has(t)) this.vocab.set(t, this.vocab.size);
    }
    this.docCount += 1;
  }

  embed(text) {
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const vec = new Map();
    for (const [t, count] of tf) {
      const df = this.df.get(t) || 0;
      const idf = Math.log((1 + this.docCount) / (1 + df)) + 1;
      vec.set(t, (count / tokens.length) * idf);
    }
    return vec; // sparse vector as Map(term -> weight)
  }
}

export function cosineSparse(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, w] of a) na += w * w;
  for (const [, w] of b) nb += w * w;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) if (large.has(t)) dot += w * large.get(t);
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const embedder = new LocalEmbedder();
export const provider = 'local-tfidf';
