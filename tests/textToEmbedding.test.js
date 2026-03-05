import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app, TEST_SECRET, MOCK_GENERATE_EMBEDDING } from './setup.js';

describe('POST /text-to-embedding', () => {
  beforeEach(() => {
    MOCK_GENERATE_EMBEDDING.mockClear();
    MOCK_GENERATE_EMBEDDING.mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
    });
  });

  // ── Required parameters ───────────────────────────────────────────

  it('returns 400 when text is missing', async () => {
    const res = await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ provider: 'openai' })
      .expect(400);

    expect(res.body).toHaveProperty('error', true);
    expect(res.body.message).toMatch(/text/i);
  });

  // ── Successful request ────────────────────────────────────────────

  it('returns 200 with correct response shape (minimal params)', async () => {
    const res = await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ text: 'Hello world' })
      .expect(200);

    expect(res.body).toHaveProperty('embedding');
    expect(Array.isArray(res.body.embedding)).toBe(true);
    expect(res.body).toHaveProperty('provider', 'openai');
  });

  // ── Optional: provider (defaults to openai) ───────────────────────

  it('defaults provider to openai when omitted', async () => {
    const res = await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ text: 'Hello world' })
      .expect(200);

    expect(res.body).toHaveProperty('provider', 'openai');
  });

  it('uses custom provider when specified', async () => {
    const res = await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ provider: 'google', text: 'Hello world' })
      .expect(200);

    expect(res.body).toHaveProperty('provider', 'google');
    expect(MOCK_GENERATE_EMBEDDING).toHaveBeenCalledTimes(1);
  });

  // ── Optional: model ───────────────────────────────────────────────

  it('passes model to the provider when provided', async () => {
    await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({
        provider: 'openai',
        text: 'Hello world',
        model: 'text-embedding-3-large',
      })
      .expect(200);

    expect(MOCK_GENERATE_EMBEDDING).toHaveBeenCalledTimes(1);
    const calledModel = MOCK_GENERATE_EMBEDDING.mock.calls[0][1];
    expect(calledModel).toBe('text-embedding-3-large');
  });

  it('passes undefined model when omitted', async () => {
    await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ text: 'Hello world' })
      .expect(200);

    const calledModel = MOCK_GENERATE_EMBEDDING.mock.calls[0][1];
    expect(calledModel).toBeUndefined();
  });

  // ── Text parameter ────────────────────────────────────────────────

  it('sends text to the provider', async () => {
    await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ text: 'The quick brown fox' })
      .expect(200);

    const calledText = MOCK_GENERATE_EMBEDDING.mock.calls[0][0];
    expect(calledText).toBe('The quick brown fox');
  });

  // ── Error handling ────────────────────────────────────────────────

  it('returns 400 for provider that does not support embeddings', async () => {
    const res = await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ provider: 'elevenlabs', text: 'Hello' })
      .expect(400);

    expect(res.body).toHaveProperty('error', true);
    expect(res.body.message).toMatch(/embeddings/i);
  });

  it('returns 500 when provider throws', async () => {
    MOCK_GENERATE_EMBEDDING.mockRejectedValueOnce(
      new Error('Embedding service down'),
    );

    const res = await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ text: 'Hello' })
      .expect(500);

    expect(res.body).toHaveProperty('error', true);
  });

  it('returns error for unknown provider', async () => {
    const res = await request(app)
      .post('/text-to-embedding')
      .set('x-api-secret', TEST_SECRET)
      .send({ provider: 'nonexistent', text: 'Hello' })
      .expect(500);

    expect(res.body).toHaveProperty('error', true);
  });
});
