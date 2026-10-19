/**
 * Labeled requests for the agent router: `route: true` means "a job for tools that the grammar does not
 * already handle"; `false` means "must not be offered to the agent" (conversation, writing, vague wishes).
 *
 * R_A was used to calibrate thresholds. R_B was written after calibration and is the honest measure.
 */

export interface Route {
  text: string;
  route: boolean;
}

const t = (...texts: string[]): Route[] => texts.map((text) => ({ text, route: true }));
const f = (...texts: string[]): Route[] => texts.map((text) => ({ text, route: false }));

export const R_A: Route[] = [
  ...t(
    'find my largest videos and move them to the D drive',
    'zip up my documents folder and then show me how big the zip is',
    'check how much space my downloads folder uses and then clean out the temp files',
    'find all the pdf files in my documents and copy them to a new folder on the desktop',
    'open notepad and then take a screenshot of it',
    'look for duplicate photos in my pictures folder and show me which ones',
    'see which programs start with windows and tell me which are the biggest',
    'run the tests and then show me the git status',
    'compare my two backup folders and list what is missing',
    'find files i have not opened in a year and list them by size',
    'create a folder called archive and move all my old logs into it',
    'check if my disk is nearly full and show the largest folders on it',
    'back up my documents folder to the D drive and tell me when it is done',
    'install the dependencies and then run the build',
    'clear my recycle bin and then show how much free space is left on c',
    'rename all the txt files in my notes folder to start with 2026',
    'show my running processes and close the one using the most memory',
    'find the biggest file on my desktop and open its folder',
  ),
  ...f(
    'write a poem about my cat and the sea',
    'draft an email to my boss asking for friday off',
    'explain how the stock market works in simple terms',
    'tell me a story about a dragon who loves tea',
    'summarize the main ideas of stoicism for me',
    'plan a three day trip to lisbon for me',
    'translate this paragraph into french please',
    'what do you think is the best programming language to learn',
    'i feel tired today and i do not know what to do',
    'help me understand why my code might be slow',
    'suggest some names for my new startup',
    'pretend you are a pirate and greet me',
    'can you check what the weather is like in paris',
    'tidy up my life',
    'make me happy',
    'please be more concise from now on',
    'give me some ideas for a birthday present',
    'the quick brown fox jumps over the lazy dog today',
  ),
];

export const R_B: Route[] = [
  ...t(
    'collect all the screenshots on my desktop into a new folder and zip it',
    'find the five largest files in downloads and show me where they are',
    'check my startup programs and tell me which ones i could turn off',
    'create a backup of my pictures folder and then check its size',
    'open my project folder, run the tests, and show me the results',
    'delete the empty folders in my documents and then list what remains',
    'look through my downloads for installers and list them with their sizes',
    'copy my notes folder to the desktop and then open it',
    'find every log file on my D drive bigger than a hundred megabytes',
    'get the latest changes, install the packages, and start the build',
    'show me what changed in my project this week and count the todo comments',
    'hash all the exe files in my downloads folder and list them',
  ),
  ...f(
    'write a cover letter for a software job',
    'what is the difference between a process and a thread',
    'give me a recipe for banana bread',
    'tell me something interesting about octopuses',
    'rewrite this sentence to sound friendlier',
    'brainstorm blog topics about gardening',
    'i am bored',
    'what should i have for dinner tonight',
    'describe the color blue to someone who cannot see',
    'organize my thoughts about the move to a new city',
    'thanks that was really helpful today',
    'never mind forget it',
  ),
];
