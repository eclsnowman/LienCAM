import { readFileSync } from 'node:fs';

// GitHub renders issue-form IDs as these display headings in the issue body.
const BUG_FIELDS = [
  'What kind of problem is it?', 'LienCAM version', 'Windows version',
  'Controller you were using', 'Did this happen with the cutter on a real machine?',
  'Steps to reproduce', 'What you expected, and what happened instead', 'Before you submit',
];
const IDEA_FIELDS = [
  'What are you trying to do that LienCAM makes hard or impossible?',
  'What would you like it to do?', 'Area', 'Before you submit',
];
const MACHINE_KIND = 'The machine moved wrongly or the cut came out wrong (G-code or live control)';
const FALLBACKS = {
  'received.md': 'Thanks for the report; a person will look at it and update this issue as more is learned, with no date promised.',
  'need-info.md': 'Thanks for the report; please fill in <list> and attach a project file if you can.',
  'safety-first.md': 'Press your E-STOP first and make sure everyone is safe; when safe, share what the machine did and the project file.',
  'idea.md': 'Thanks for the idea; please post it in Discussions > Ideas: <ideas-url>.',
};

export function parseFields(body) {
  const fields = new Map();
  const sections = String(body ?? '').replace(/\r\n/g, '\n').split(/^### /m).slice(1);
  for (const section of sections) {
    const newline = section.indexOf('\n');
    const heading = section.slice(0, newline).trim();
    // Quoted form headings later in a textarea must not overwrite earlier answers.
    if (newline !== -1 && !fields.has(heading)) fields.set(heading, section.slice(newline + 1).trim());
  }
  return fields;
}

export function decideIntake(payload) {
  const issue = payload.issue;
  const fields = parseFields(issue.body);
  const existingLabels = (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
  // Prefer the form's labels over headings quoted in free-text answers. A bug
  // label wins a mixed-label payload so a machine report retains its reminder.
  const form = existingLabels.includes('bug') ? 'bug' : existingLabels.includes('idea') ? 'idea'
    : fields.has(BUG_FIELDS[0]) ? 'bug' : fields.has(IDEA_FIELDS[0]) ? 'idea' : null;
  const isIdea = form === 'idea';
  const isBug = form === 'bug';
  const required = isIdea ? IDEA_FIELDS : isBug ? BUG_FIELDS : [];
  const missingFields = required.filter(heading => {
    const answer = fields.get(heading);
    if (!answer || answer === '_No response_') return true;
    // Required form checkboxes must be checked, not merely present as text.
    return heading === 'Before you submit' && (answer.match(/^- \[[xX]\]/gm) ?? []).length < (isIdea ? 1 : 2);
  });
  if (!required.length) missingFields.push('the bug or feature form fields');

  const labels = ['needs-triage'];
  const replies = ['received.md'];
  if (isIdea) {
    labels.push('idea');
    replies.push('idea.md');
  } else if (isBug && fields.get(BUG_FIELDS[0]) === MACHINE_KIND) {
    labels.push('needs-repro');
    replies.push('safety-first.md');
  }
  if (missingFields.length) {
    labels.push('needs-info');
    replies.push('need-info.md');
  }
  return { labels, replies, missingFields };
}

function readSavedReply(file) {
  return readFileSync(new URL(`../replies/${file}`, import.meta.url), 'utf8');
}

export function renderReply(file, decision, repo, readReply = readSavedReply) {
  let text;
  try {
    text = readReply(file).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  text ||= FALLBACKS[file];
  // The shared reply also serves manual conversions. Intake only comments.
  if (file === 'idea.md') text = text.replace(/I have moved it there:/gi, 'please post it in Discussions > Ideas:');
  return text.replaceAll('<list>', decision.missingFields.join('; '))
    .replaceAll('<ideas-url>', `https://github.com/${repo.owner}/${repo.repo}/discussions/categories/ideas`);
}

export async function runIntake({ github, context, readReply = readSavedReply }) {
  const decision = decideIntake(context.payload);
  const target = { ...context.repo, issue_number: context.payload.issue.number };
  const comments = await github.paginate(github.rest.issues.listComments, { ...target, per_page: 100 });
  await github.rest.issues.addLabels({ ...target, labels: decision.labels });
  for (const file of decision.replies) {
    const marker = `<!-- liencam-issue-intake:${file} -->`;
    // A reporter quoting the marker must not suppress the bot's reply.
    if (comments.some(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(marker))) continue;
    await github.rest.issues.createComment({
      ...target, body: `${renderReply(file, decision, context.repo, readReply)}\n\n${marker}`,
    });
  }
  return decision;
}
