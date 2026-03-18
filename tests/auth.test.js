import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './setup.js';

describe('Auth Middleware', () => {
  it('returns 200 for requests without any auth headers', async () => {
    const res = await request(app).get('/config').expect(200);

    expect(res.body).toHaveProperty('providers');
  });

  it('attaches x-project header value to req.project', async () => {
    const res = await request(app)
      .post('/chat?stream=false')
      .set('x-project', 'my-project')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    expect(res.body).toHaveProperty('text');
  });

  it("defaults x-project to 'unknown' when header is absent", async () => {
    const res = await request(app)
      .post('/chat?stream=false')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    expect(res.body).toHaveProperty('text');
  });

  it('attaches x-username header value to req.username', async () => {
    const res = await request(app)
      .post('/chat?stream=false')
      .set('x-project', 'my-project')
      .set('x-username', 'rodrigo')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    expect(res.body).toHaveProperty('text');
  });

  it("defaults x-username to 'unknown' when header is absent", async () => {
    const res = await request(app)
      .post('/chat?stream=false')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    expect(res.body).toHaveProperty('text');
  });
});
