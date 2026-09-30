/**
 * Dragging files onto the chat bar.
 *
 * The behaviour worth pinning: nothing is on screen until a file is over the bar;
 * the drop attaches only when it lands on the bar; several files of different
 * kinds arrive together and in order; and attaching never reads a file.
 */
import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileDragEvent, PathInfo, Platform } from '@atlas/core';
import { Composer } from '../src/components/Composer';
import { DropOverlay } from '../src/components/DropOverlay';
import {
  IDLE,
  MAX_DROPPED_FILES,
  dropDecision,
  type DropRect,
  type DropState,
} from '../src/atlas/useFileDrop';
import { buildAttachments } from '../src/atlas/useAttachments';

const BAR: DropRect = { left: 20, top: 500, right: 780, bottom: 560 };
const PICTURES = ['D:\\Pics\\cat.PNG', 'D:\\Pics\\dog.jpg', 'D:\\Clips\\run.mp4'];

const event = (
  phase: FileDragEvent['phase'],
  x: number,
  y: number,
  paths: string[] = [],
): FileDragEvent => ({
  phase,
  paths,
  x,
  y,
});
const OVER = { x: 400, y: 530 };
const ELSEWHERE = { x: 400, y: 100 };

function step(state: DropState, e: FileDragEvent) {
  return dropDecision(state, e, BAR);
}

describe('the drop zone is invisible until a file is over the chat bar', () => {
  test('at rest, nothing is drawn — the overlay is not in the page at all', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        onSubmit: () => {},
        busy: false,
        executionMode: 'doIt',
        onCycleExecutionMode: () => {},
      }),
    );
    expect(html).not.toContain('Drop to attach');
    expect(html).not.toContain('border-dashed');
  });

  test('a drag that has entered the window but is not over the bar shows nothing', () => {
    const state = step(IDLE, event('enter', ELSEWHERE.x, ELSEWHERE.y, PICTURES)).state;
    expect(state.active).toBe(false);
  });

  test('moving onto the bar switches it on, moving off switches it off, leaving clears it', () => {
    let s = step(IDLE, event('enter', ELSEWHERE.x, ELSEWHERE.y, PICTURES)).state;
    s = step(s, event('over', OVER.x, OVER.y)).state; // `over` carries no paths
    expect(s.active).toBe(true);
    s = step(s, event('over', ELSEWHERE.x, ELSEWHERE.y)).state;
    expect(s.active).toBe(false);
    s = step(s, event('over', OVER.x, OVER.y)).state;
    expect(s.active).toBe(true);
    s = step(s, event('leave', 0, 0)).state;
    expect(s).toEqual(IDLE);
  });

  test('a drag carrying no files never lights it up', () => {
    expect(step(IDLE, event('enter', OVER.x, OVER.y, [])).state.active).toBe(false);
  });

  test('the overlay, when shown, says what will happen and never takes the pointer', () => {
    const one = renderToStaticMarkup(createElement(DropOverlay, { count: 1 }));
    expect(one).toContain('Drop to attach');
    expect(one).not.toContain('files');
    expect(one).toContain('pointer-events-none');
    expect(renderToStaticMarkup(createElement(DropOverlay, { count: 3 }))).toContain(
      'Drop to attach 3 files',
    );
  });
});

describe('what a drop does', () => {
  test('a drop on the bar hands over every file, in order — PNG, JPG and MP4 together', () => {
    const entered = step(IDLE, event('enter', OVER.x, OVER.y, PICTURES)).state;
    const result = step(entered, event('drop', OVER.x, OVER.y, PICTURES));
    expect(result.dropped).toEqual(PICTURES);
    expect(result.state).toEqual(IDLE);
  });

  test('a drop remembers the files from the start of the drag if its own event carries none', () => {
    const entered = step(IDLE, event('enter', ELSEWHERE.x, ELSEWHERE.y, PICTURES)).state;
    expect(step(entered, event('drop', OVER.x, OVER.y)).dropped).toEqual(PICTURES);
  });

  test('a drop anywhere else attaches nothing', () => {
    const entered = step(IDLE, event('enter', OVER.x, OVER.y, PICTURES)).state;
    const result = step(entered, event('drop', ELSEWHERE.x, ELSEWHERE.y, PICTURES));
    expect(result.dropped).toBeUndefined();
    expect(result.state).toEqual(IDLE);
  });

  test('a drop with the bar not on screen (no rectangle) attaches nothing', () => {
    expect(
      dropDecision(IDLE, event('drop', OVER.x, OVER.y, PICTURES), null).dropped,
    ).toBeUndefined();
  });

  test('a huge drop is capped rather than swamping the message', () => {
    const many = Array.from({ length: MAX_DROPPED_FILES + 10 }, (_, i) => `D:\\f${i}.png`);
    const result = step(IDLE, event('drop', OVER.x, OVER.y, many));
    expect(result.dropped).toHaveLength(MAX_DROPPED_FILES);
    expect(result.dropped![0]).toBe('D:\\f0.png');
  });
});

describe('what a dropped path becomes', () => {
  /** Only path_info exists. Anything that read a file would have nowhere to go. */
  function platform(dirs: string[] = []): Platform {
    return {
      pathInfo: async (path: string): Promise<PathInfo> => ({
        path,
        name: path.split('\\').pop() ?? '',
        ext: '',
        isDirectory: dirs.includes(path),
        sizeBytes: 4096,
      }),
    } as unknown as Platform;
  }

  test('PNG, JPG and MP4 become references — images as images, video as a file', async () => {
    const items = await buildAttachments(platform(), PICTURES);
    expect(items.map((a) => [a.name, a.kind])).toEqual([
      ['cat.PNG', 'image'],
      ['dog.jpg', 'image'],
      ['run.mp4', 'file'],
    ]);
    expect(items.map((a) => a.path)).toEqual(PICTURES);
    expect(new Set(items.map((a) => a.id)).size).toBe(3);
  });

  test('attaching only ever looks at path info — it does not read the file', async () => {
    const calls: string[] = [];
    const spy = {
      pathInfo: async (p: string) => {
        calls.push(`info:${p}`);
        return { path: p, name: 'x', ext: '', isDirectory: false, sizeBytes: 10 };
      },
      readTextFile: async () => {
        calls.push('READ');
        return '';
      },
    } as unknown as Platform;
    await buildAttachments(spy, ['D:\\notes.txt', 'D:\\doc.pdf']);
    expect(calls).not.toContain('READ');
  });

  test('a video or an image offers no text to extract; a folder is a reference too', async () => {
    const items = await buildAttachments(platform(['D:\\Project']), [
      'D:\\Clips\\run.mp4',
      'D:\\Project',
    ]);
    expect(items[0]!.extraction).toBe('unsupported');
    expect(items[1]!.extraction).toBe('unsupported');
    expect(items[1]!.sizeBytes).toBeUndefined();
  });

  test('a file already attached is not attached twice, whatever the case of its path', async () => {
    const items = await buildAttachments(
      platform(),
      ['D:\\Pics\\cat.png', 'd:\\pics\\CAT.png', 'D:\\Pics\\new.png'],
      new Set(['D:\\Pics\\cat.png']),
    );
    expect(items.map((a) => a.name)).toEqual(['new.png']);
  });

  test('a platform without path_info still attaches, judged on format alone', async () => {
    const items = await buildAttachments({} as Platform, ['D:\\a.png']);
    expect(items).toHaveLength(1);
    expect(items[0]!.sizeBytes).toBeUndefined();
  });
});
