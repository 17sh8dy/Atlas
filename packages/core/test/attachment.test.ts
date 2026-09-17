/**
 * Attachments — the rules that decide what Atlas will claim it can read.
 *
 * The bug class this guards is a specific one: an attachment UI that reads
 * anything it is handed, produces mojibake for a `.docx` (which is a zip) and
 * a wall of binary for a PDF, and teaches the person that attaching files
 * doesn't really work. Every case below is a promise Atlas makes *before* the
 * file is read, on the chip, so the answer arrives before the disappointment.
 */

import { test, assert } from 'vitest';
import {
  describeAttachment,
  extensionOf,
  extractionStateFor,
  isImageFile,
  formatBytes,
  EXTRACTION_NOT_BUILT_YET,
  MAX_EXTRACTABLE_BYTES,
  type Attachment,
} from '../src/models/attachment';

test('an extension is read from a name or a full path, on either separator', () => {
  assert.equal(extensionOf('notes.txt'), 'txt');
  assert.equal(extensionOf('C:\\Users\\me\\report.PDF'), 'pdf');
  assert.equal(extensionOf('/home/me/src/main.rs'), 'rs');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('Makefile'), 'makefile');
});

test('a dotfile is named by its whole self rather than by nothing', () => {
  // ".gitignore" is a text file people genuinely attach, and reading it as an
  // empty extension would make it unsupported for no reason.
  assert.equal(extensionOf('.gitignore'), 'gitignore');
  assert.equal(extractionStateFor(extensionOf('.gitignore')), 'available');
});

test('text formats are extractable and binary ones are not', () => {
  for (const ext of ['txt', 'md', 'json', 'ts', 'rs', 'csv', 'yaml', 'log']) {
    assert.equal(extractionStateFor(ext), 'available', `${ext} should be readable`);
  }
  for (const ext of ['png', 'mp4', 'zip', 'exe', 'dll']) {
    assert.equal(extractionStateFor(ext), 'unsupported', `${ext} should not be`);
  }
});

test('the formats people expect to work are named, not lumped in with binaries', () => {
  // The difference that matters to a person: "no extractor for this yet" is a
  // gap being worked on, "unsupported" is a shrug. A PDF deserves the first.
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx', 'rtf', 'epub']) {
    assert.equal(extractionStateFor(ext), 'unsupported');
    assert.isTrue(EXTRACTION_NOT_BUILT_YET.has(ext), `${ext} should be named as not-yet-built`);
  }
});

test('a file past the read cap says so instead of failing later', () => {
  assert.equal(extractionStateFor('txt', MAX_EXTRACTABLE_BYTES + 1), 'too-large');
  assert.equal(extractionStateFor('txt', MAX_EXTRACTABLE_BYTES), 'available');
  // Format is judged first: an oversized video is unsupported, not too-large,
  // because its size was never the reason.
  assert.equal(extractionStateFor('mp4', MAX_EXTRACTABLE_BYTES * 100), 'unsupported');
});

test('size is unknown until asked, and an unknown size does not block anything', () => {
  assert.equal(extractionStateFor('txt', undefined), 'available');
});

test('images are recognised by extension, case-insensitively', () => {
  assert.isTrue(isImageFile('holiday.JPG'));
  assert.isTrue(isImageFile('C:\\shots\\bug.png'));
  assert.isFalse(isImageFile('notes.txt'));
});

function attachment(over: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    kind: 'file',
    name: 'notes.txt',
    ext: 'txt',
    addedAt: 0,
    extraction: 'available',
    ...over,
  };
}

test('the chip line says what a person needs before they send', () => {
  assert.include(
    describeAttachment(attachment({ ext: 'pdf', extraction: 'unsupported', sizeBytes: 2048 })),
    'text not extractable yet',
  );
  assert.include(
    describeAttachment(attachment({ extraction: 'too-large', sizeBytes: 1_000_000 })),
    'too big to read',
  );
  assert.include(
    describeAttachment(attachment({ extraction: 'extracted' })),
    'contents added',
  );
  assert.include(
    describeAttachment(attachment({ extraction: 'extracted', truncated: true })),
    'truncated',
  );
});

test('a capture is described by its size on screen, not by a file name', () => {
  const line = describeAttachment(
    attachment({ kind: 'screenshot', name: 'Screen 1', ext: 'png', width: 3840, height: 2160, extraction: 'unsupported' }),
  );
  assert.include(line, '3840×2160');
});

test('bytes read as a person would say them', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
  assert.equal(formatBytes(1024 * 1024 * 40), '40 MB');
});
