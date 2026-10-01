/**
 * Looking at and lightly editing media with ffmpeg (tool-catalog pass): a file's
 * length, size and frame rate; trim a clip; take a still from a video; rotate, flip,
 * square-crop or shrink a picture to a thumbnail.
 *
 * Reading is `safe`. Every edit makes a NEW file beside the original and never
 * replaces anything (the native side picks a free name and runs ffmpeg with -n), so
 * those are `safe` too — same reasoning as media.convert / media.compress.
 */

import type { Memory, Platform, Skill } from '@atlas/core';
import { resolveTarget } from './locate';

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const fail = (e: unknown, fallback: string) => ({
  ok: false as const,
  error: e instanceof Error ? e.message : typeof e === 'string' ? e : fallback,
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function createCatalogMediaSkills(platform: Platform, memory?: Memory): Skill[] {
  const skills: Skill[] = [];
  const locate = (spec: unknown) => resolveTarget(platform, memory, String(spec ?? ''));
  const shown = (out: string, ctx: Parameters<Skill['run']>[1], title: string) =>
    ctx.showResults?.(
      [{ title: basename(out), subtitle: out, icon: '🎞️', payload: { path: out }, actions: [{ label: 'Open', skill: 'files.open', args: { path: out } }, { label: 'Show in folder', skill: 'files.reveal', args: { path: out } }] }],
      { title },
    );

  skills.push({
    id: 'media.info',
    label: 'About a video, audio or picture',
    icon: '🎞️',
    domain: 'files',
    description: 'How long a video or song is, a picture or video’s size in pixels, its frame rate and codecs.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['how long is clip.mp4 in videos', 'what resolution is photo.png in pictures'],
    params: { target: { type: 'string', required: true, description: 'the file, in words or a path' } },
    async run(args) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const i = await platform.mediaInfo!(t.path);
        const bits = [
          i.durationSeconds != null ? `${clock(i.durationSeconds)} long` : '',
          i.width && i.height ? `${i.width}×${i.height}` : '',
          // A still picture reports a made-up frame rate and calls itself a video stream.
          i.durationSeconds != null && i.fps ? `${i.fps} fps` : '',
          i.videoCodec ? (i.durationSeconds != null ? `video ${i.videoCodec}` : i.videoCodec) : '',
          i.audioCodec ? `audio ${i.audioCodec}` : '',
          i.bitrateKbps ? `${i.bitrateKbps} kb/s` : '',
          formatBytes(i.sizeBytes),
        ].filter(Boolean);
        return { ok: true, message: `🎞️ ${basename(t.path)}: ${bits.join(' · ')}`, data: i };
      } catch (e) {
        return fail(e, `I couldn't read ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'media.trim',
    label: 'Trim a clip',
    icon: '✂️',
    domain: 'files',
    description: 'Cut a video or audio file down to a start and end time. The original is untouched; the cut is a new file beside it.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['trim clip.mp4 in videos from 10 to 30'],
    params: {
      target: { type: 'string', required: true, description: 'the file, in words or a path' },
      start: { type: 'number', required: true, description: 'start, in seconds' },
      end: { type: 'number', required: true, description: 'end, in seconds' },
    },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const r = await platform.editMedia!(t.path, 'trim', Number(args.start), Number(args.end));
        shown(r.output, ctx, 'Trimmed');
        return { ok: true, spoken: true, message: `✂️ Cut ${clock(Number(args.start))}–${clock(Number(args.end))} of ${basename(t.path)} → ${basename(r.output)}`, data: r };
      } catch (e) {
        return fail(e, `I couldn't trim ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'media.frame',
    label: 'Take a still from a video',
    icon: '📸',
    domain: 'files',
    description: 'Save one frame of a video, at a time you give, as a picture beside it.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['grab a frame from clip.mp4 in videos at 12'],
    params: {
      target: { type: 'string', required: true, description: 'the video' },
      at: { type: 'number', required: true, description: 'when, in seconds' },
    },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      try {
        const r = await platform.editMedia!(t.path, 'frame', Number(args.at));
        shown(r.output, ctx, 'Still');
        return { ok: true, spoken: true, message: `📸 Saved the frame at ${clock(Number(args.at))} → ${basename(r.output)}`, data: r };
      } catch (e) {
        return fail(e, `I couldn't take a still from ${basename(t.path)}.`);
      }
    },
  });

  skills.push({
    id: 'media.edit',
    label: 'Rotate, flip, square-crop or shrink a picture',
    icon: '🖼️',
    domain: 'files',
    description: 'Rotate a picture 90 / 180 / 270 degrees, flip it sideways or upside down, crop it to a centred square, or make a 256-pixel thumbnail. A new picture is saved beside the original.',
    needs: ['fs'],
    risk: 'safe',
    examples: ['rotate photo.png in pictures 90 degrees', 'make a thumbnail of photo.png in pictures'],
    params: {
      target: { type: 'string', required: true, description: 'the picture' },
      op: { type: 'string', required: true, enum: ['rotate', 'flip', 'square', 'thumbnail'], description: 'what to do' },
      amount: { type: 'number', required: false, description: 'rotate: 90, 180 or 270 clockwise; flip: 0 sideways, 1 upside down' },
    },
    async run(args, ctx) {
      const t = await locate(args.target);
      if (!t.ok) return { ok: false, error: t.error };
      const op = String(args.op);
      try {
        const r = await platform.editMedia!(t.path, op, args.amount === undefined ? undefined : Number(args.amount));
        shown(r.output, ctx, 'Done');
        const verb = op === 'rotate' ? 'Rotated' : op === 'flip' ? 'Flipped' : op === 'square' ? 'Cropped to a square' : 'Made a thumbnail of';
        return { ok: true, spoken: true, message: `🖼️ ${verb} ${basename(t.path)} → ${basename(r.output)}`, data: r };
      } catch (e) {
        return fail(e, `I couldn't edit ${basename(t.path)}.`);
      }
    },
  });

  return skills;
}
