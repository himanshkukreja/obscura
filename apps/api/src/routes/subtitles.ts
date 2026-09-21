import type { FastifyInstance } from 'fastify';
import { uuidv7, badRequest, notFound, queueJobId } from '@obscura/shared';
import { cuesToVtt } from '@obscura/media';
import { defaultJobOptions } from '../queue.ts';
import { requireClient } from '../app.ts';
import type { Deps } from '../deps.ts';

const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function registerSubtitleRoutes(app: FastifyInstance, deps: Deps): void {
  // Upload WebVTT or SRT as a body.
  app.post('/api/v1/assets/:id/subtitles', {
    schema: {
      body: {
        type: 'object',
        required: ['language', 'content'],
        properties: {
          language: { type: 'string', maxLength: 32 },
          label: { type: 'string', maxLength: 64 },
          is_default: { type: 'boolean' },
          content: { type: 'string', minLength: 1, maxLength: 4 * 1024 * 1024 },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body as { language: string; label?: string; is_default?: boolean; content: string };
    return enqueue(app, deps, req, reply, {
      language: b.language, label: b.label ?? null,
      isDefault: b.is_default ?? false, origin: 'upload', vtt: b.content,
    });
  });

  /**
   * Import timed cues directly, so a platform that already holds a transcript can turn it
   * into subtitles without producing a file. Usually the highest-value-per-line feature
   * available to any deployment that already transcribes its media.
   */
  app.post('/api/v1/assets/:id/subtitles/import', {
    schema: {
      body: {
        type: 'object',
        required: ['language', 'cues'],
        properties: {
          language: { type: 'string', maxLength: 32 },
          label: { type: 'string', maxLength: 64 },
          is_default: { type: 'boolean' },
          cues: {
            type: 'array', minItems: 1, maxItems: 100_000,
            items: {
              type: 'object',
              required: ['start_ms', 'end_ms', 'text'],
              properties: {
                start_ms: { type: 'integer', minimum: 0 },
                end_ms: { type: 'integer', minimum: 0 },
                text: { type: 'string', minLength: 1, maxLength: 2000 },
              },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const b = req.body as {
      language: string; label?: string; is_default?: boolean;
      cues: { start_ms: number; end_ms: number; text: string }[];
    };
    const bad = b.cues.find((c) => c.end_ms <= c.start_ms);
    if (bad) throw badRequest('Every cue must have end_ms greater than start_ms', { cue: bad });

    const vtt = cuesToVtt(
      b.cues.map((c) => ({ startMs: c.start_ms, endMs: c.end_ms, text: c.text })),
    );
    return enqueue(app, deps, req, reply, {
      language: b.language, label: b.label ?? null,
      isDefault: b.is_default ?? false, origin: 'transcript_import', vtt,
    });
  });

  app.get('/api/v1/assets/:id/subtitles', async (req) => {
    const client = await requireClient(deps, req);
    const { id } = req.params as { id: string };
    if (!(await deps.repos.assets.byIdForClient(id, client.id))) throw notFound(`Asset ${id} not found`);
    const tracks = await deps.repos.subtitles.forAsset(id);
    return {
      data: tracks.map((t) => ({
        id: t.id, language: t.language, label: t.label, kind: t.kind,
        is_default: t.is_default, origin: t.origin, cue_count: t.cue_count,
      })),
    };
  });
}

async function enqueue(
  _app: FastifyInstance, deps: Deps, req: Parameters<typeof requireClient>[1], reply: { status: (n: number) => { send: (b: unknown) => unknown } },
  t: { language: string; label: string | null; isDefault: boolean; origin: string; vtt: string },
) {
  const client = await requireClient(deps, req);
  const { id } = req.params as { id: string };
  if (!BCP47.test(t.language)) throw badRequest('language must be a BCP-47 tag, e.g. "en" or "pt-BR"');

  const asset = await deps.repos.assets.byIdForClient(id, client.id);
  if (!asset) throw notFound(`Asset ${id} not found`);

  const trackId = uuidv7();
  await deps.queue.add('subtitles', {
    type: 'subtitles', assetId: id, trackId,
    language: t.language, label: t.label, isDefault: t.isDefault, origin: t.origin, vtt: t.vtt,
  }, { ...defaultJobOptions, jobId: queueJobId(`${id}:subs:${t.language}:${Date.now()}`) });

  return reply.status(202).send({ track_id: trackId, language: t.language, queued: true });
}
