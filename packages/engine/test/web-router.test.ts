/**
 * The routing decision, checked against a table of real phrasings in both
 * directions. The negative table matters as much as the positive one: a
 * router that searches everything is slow, spends a metered quota, and sends
 * the user's private questions off the machine for no reason.
 */
import { describe, expect, test } from 'vitest';
import { needsWebSearch, routeQuestion } from '../src/web/router';

const SHOULD_SEARCH: Array<[string, string]> = [
  // the example that started this: no freshness word in it at all
  ['What season of Fortnite is it?', 'release'],
  ['what chapter is fortnite on', 'release'],
  ['what version of Minecraft is out', 'release'],
  ['what patch is Valorant on right now', 'release'],
  ['when does the new season of Apex start', 'release'],
  ['when is GTA 6 coming out', 'release'],
  ['is the game out yet', 'release'],
  ['what happened in the latest Fortnite update?', 'recency'],
  ['what is the newest iPhone', 'release'],
  ['whats the latest news on the election', 'news'],
  ['who won the game last night', 'live'],
  ['who won the Lakers game', 'live'],
  ['what is the weather in Chicago', 'live'],
  ['weather tomorrow', 'live'],
  ['is Discord down', 'live'],
  ['is github having issues', 'live'],
  ['price of bitcoin', 'price'],
  ['how much does a PS5 cost now', 'price'],
  ['what is the exchange rate for euros', 'price'],
  ['who is the current CEO of Microsoft', 'role'],
  ['who is the prime minister of the UK', 'role'],
  ['best gaming laptops in 2026', 'dated'],
  ['NBA schedule 2026 results', 'dated'],
  ['search for cheap flights to Tokyo', 'explicit'],
  ['research the best budget laptop', 'explicit'],
  ['can you google the patch notes', 'explicit'],
  ['look up the release date of Hollow Knight Silksong', 'explicit'],
  ['breaking news', 'news'],
  ['any news about the strike', 'news'],
  ['what is the current version of Node', 'release'],
  ['did they release the update yet', 'release'],
];

const SHOULD_STAY_OFFLINE: string[] = [
  'how do I reverse a list in Python',
  'how do I update a driver',
  'how to write a new function in JavaScript',
  'explain how recursion works',
  'what does idempotent mean',
  'what is the difference between TCP and UDP',
  'write me a poem about the sea',
  'translate good morning into Spanish',
  'calculate 15% of 240',
  'summarize this paragraph',
  'tell me a joke',
  'why is the sky blue',
  'what is a black hole',
  'how do I get the current date in Python',
  'how do I get today in JavaScript',
  'is my code working',
  'how do I search for a substring in Python',
  'define entropy',
  'what is the capital of France',
  'hello there',
  'thanks',
  'give me an example of a for loop',
  'fix this stack trace',
];

describe('routeQuestion — needs the web', () => {
  test.each(SHOULD_SEARCH)('%s', (text, category) => {
    const d = routeQuestion(text);
    expect(d.search, `"${text}" should search`).toBe(true);
    expect(d.category).toBe(category);
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe('routeQuestion — stays offline', () => {
  test.each(SHOULD_STAY_OFFLINE)('%s', (text) => {
    expect(routeQuestion(text).search, `"${text}" should NOT search`).toBe(false);
  });
});

describe('routeQuestion — details', () => {
  test('news and live questions ask for the news topic, others do not', () => {
    expect(routeQuestion('breaking news').topic).toBe('news');
    expect(routeQuestion('who won the game last night').topic).toBe('news');
    expect(routeQuestion('what season of Fortnite is it').topic).toBe('general');
  });

  test('empty input never searches', () => {
    expect(routeQuestion('').search).toBe(false);
    expect(routeQuestion('   ').search).toBe(false);
  });

  test('a weak signal alone still searches when nothing marks the question timeless', () => {
    expect(routeQuestion('is the Steam Deck still on sale').search).toBe(true);
  });

  test('a release question about code is not swallowed by the code guard', () => {
    expect(routeQuestion("what's the newest feature in Python").search).toBe(true);
  });

  test('needsWebSearch is the same decision as a boolean', () => {
    for (const [text] of SHOULD_SEARCH) expect(needsWebSearch(text)).toBe(true);
    for (const text of SHOULD_STAY_OFFLINE) expect(needsWebSearch(text)).toBe(false);
  });
});
