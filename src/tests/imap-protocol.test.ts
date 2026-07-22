import { describe, it, expect } from 'vitest';
import { tokenize, parseSequenceSet, parseUidSet } from '../imap/protocol.js';
import {
  parseMimeStructure,
  serializeBodyStructure,
  findPart,
  parseImapDate,
  imapDate,
} from '../imap/mime-structure.js';

describe('tokenize', () => {
  it('splits atoms and quoted strings', () => {
    expect(tokenize({ parts: ['a1 LOGIN "user name" pass'] })).toEqual([
      'a1',
      'LOGIN',
      'user name',
      'pass',
    ]);
  });

  it('nests parenthesized lists', () => {
    expect(tokenize({ parts: ['a2 FETCH 1:* (FLAGS UID (X Y))'] })).toEqual([
      'a2',
      'FETCH',
      '1:*',
      ['FLAGS', 'UID', ['X', 'Y']],
    ]);
  });

  it('keeps BODY sections as one token', () => {
    expect(
      tokenize({ parts: ['a3 UID FETCH 5 (BODY.PEEK[HEADER.FIELDS (FROM TO)]<0.100> UID)'] }),
    ).toEqual(['a3', 'UID', 'FETCH', '5', ['BODY.PEEK[HEADER.FIELDS (FROM TO)]<0.100>', 'UID']]);
  });

  it('injects literals at their position', () => {
    expect(
      tokenize({ parts: ['a4 LOGIN ', Buffer.from('user@x'), ' ', Buffer.from('p"ss')] }),
    ).toEqual(['a4', 'LOGIN', 'user@x', 'p"ss']);
  });
});

describe('sequence sets', () => {
  it('parses ranges, stars and lists', () => {
    expect(parseSequenceSet('1,3:5,9', 6)).toEqual([1, 3, 4, 5]);
    expect(parseSequenceSet('*', 4)).toEqual([4]);
    expect(parseSequenceSet('2:*', 4)).toEqual([2, 3, 4]);
    expect(parseSequenceSet('1:*', 0)).toEqual([]);
  });

  it('parses uid sets against sparse uid lists', () => {
    const uids = [3, 7, 20, 21];
    expect([...parseUidSet('1:10', uids)]).toEqual([3, 7]);
    expect([...parseUidSet('20:*', uids)]).toEqual([20, 21]);
    expect([...parseUidSet('7', uids)]).toEqual([7]);
    expect([...parseUidSet('8', uids)]).toEqual([]);
  });
});

const multipart = Buffer.from(
  [
    'From: a@b.c',
    'Subject: hi',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'plain body',
    '--XYZ',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<b>html body</b>',
    '--XYZ--',
    '',
  ].join('\r\n'),
);

describe('mime structure', () => {
  it('parses multipart trees with part offsets', () => {
    const root = parseMimeStructure(multipart);
    expect(root.type).toBe('multipart');
    expect(root.children).toHaveLength(2);
    const part1 = findPart(root, '1')!;
    const part2 = findPart(root, '2')!;
    expect(multipart.subarray(part1.bodyStart, part1.bodyEnd).toString()).toBe('plain body');
    expect(multipart.subarray(part2.bodyStart, part2.bodyEnd).toString()).toBe('<b>html body</b>');
  });

  it('serializes BODYSTRUCTURE', () => {
    const root = parseMimeStructure(multipart);
    const s = serializeBodyStructure(root);
    expect(s).toContain('"TEXT" "PLAIN"');
    expect(s).toContain('"TEXT" "HTML"');
    expect(s.endsWith('"ALTERNATIVE")')).toBe(true);
  });

  it('handles single-part messages', () => {
    const raw = Buffer.from('From: a@b.c\r\nContent-Type: text/plain\r\n\r\nhello\r\n');
    const root = parseMimeStructure(raw);
    expect(root.type).toBe('text');
    expect(findPart(root, '1')).toBe(root);
    expect(raw.subarray(root.bodyStart, root.bodyEnd).toString()).toBe('hello\r\n');
  });
});

describe('imap dates', () => {
  it('round-trips', () => {
    const ms = Date.UTC(2026, 6, 20, 10, 30, 0);
    expect(imapDate(ms)).toBe('20-Jul-2026 10:30:00 +0000');
    expect(parseImapDate('20-Jul-2026')).toBe(Date.UTC(2026, 6, 20));
    expect(parseImapDate('1-Jan-2026')).toBe(Date.UTC(2026, 0, 1));
    expect(parseImapDate('garbage')).toBeNull();
  });
});
