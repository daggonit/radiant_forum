// Called by the weekly-article-pr workflow.
// Reads topic-queue.md, generates an article via Claude API, writes files to disk,
// and sets GitHub Actions step outputs for the commit/PR step.
// When the queue is exhausted, auto-generates 30 new topics before proceeding.

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const queuePath = 'topic-queue.md';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is not set. Add it as a GitHub Actions secret named ANTHROPIC_API_KEY.');
  process.exit(1);
}

const client = new Anthropic({ apiKey });

function findPending(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/\|\s*pending\s*\|/.test(lines[i])) return i;
  }
  return -1;
}

async function generateNewTopics(lines) {
  const existingTitles = lines
    .filter(l => /\|/.test(l) && !/^[\s|]*[-:]+[\s|]*$/.test(l) && !/^\|\s*#\s*\|/.test(l))
    .map(l => l.split('|').map(s => s.trim())[2])
    .filter(Boolean);

  let lastNum = 0;
  for (const line of lines) {
    const cols = line.split('|').map(s => s.trim());
    const n = parseInt(cols[1]);
    if (!isNaN(n) && n > lastNum) lastNum = n;
  }

  console.log(`Queue exhausted. Generating 30 new topics starting from #${lastNum + 1}...`);

  const prompt = `You are a content strategist for Barrier Boss by Mallett Made Solutions LLC, a home energy efficiency contractor in the NC Triangle area (Raleigh, Durham, Chapel Hill, Cary, Apex).

Services: radiant barrier, attic air sealing, blown-in insulation, duct sealing, crawl space encapsulation, crawl space dehumidifiers, floor insulation, thermal imaging assessments, attic fans.

Generate 30 new blog article topics targeting real NC homeowner search queries. Mix of: cost questions, comparison questions, seasonal questions, symptom-based questions ("why is my upstairs so hot"), how-to questions, local building code questions, before/after questions, and rebate/incentive questions.

Topics already written — do NOT duplicate:
${existingTitles.map(t => `- ${t}`).join('\n')}

Output ONLY a markdown table with no intro text, no explanation, nothing before or after the table:
| # | Title | Category | Status | Sent | Published |
|---|-------|----------|--------|------|-----------|
| ${lastNum + 1} | First new title | category | pending | | |

Valid category slugs: radiant-barrier, air-sealing, insulation, duct-sealing, crawl-space, floor-insulation, thermal-assessment, attic-fan, home-energy

Output exactly 30 data rows numbered ${lastNum + 1} through ${lastNum + 30}. No other text.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  const newRows = text.split('\n')
    .filter(l => /^\|/.test(l) && !/^[\s|]*[-:]+[\s|]*$/.test(l) && !/^\|\s*#\s*\|/.test(l));

  console.log(`Generated ${newRows.length} new topics.`);
  return newRows;
}

const systemPrompt = `You are a content writer for Barrier Boss by Mallett Made Solutions LLC, a home energy efficiency contractor serving the NC Triangle area.

Business details:
- Owner: Nicolas Mallett
- Phone: (919) 971-9765
- Website: mallettmade.co
- Contact page: mallettmade.co/contact
- Service area: Raleigh, Durham, Chapel Hill, Cary, Apex, Morrisville, Wake Forest, Holly Springs, Garner, Fuquay-Varina, Hillsborough, Pittsboro

Services offered:
- Radiant barrier installation (stapled to roof deck)
- Attic air sealing (can lights, top plates, penetrations, attic hatch)
- Blown-in insulation upgrades (fiberglass or cellulose)
- Duct sealing (mastic compound and Aeroseal pressurized injection)
- Crawl space encapsulation (vapor barrier + rim joist sealing)
- Crawl space dehumidifiers
- Floor insulation below crawl spaces
- Thermal imaging assessments (FLIR camera)
- Attic fan evaluation

Target reader: NC homeowner, primarily pre-2010 construction in the Triangle area. They are dealing with high summer energy bills, hot upstairs rooms, humid crawl spaces, cold floors in winter, or high humidity indoors.

Write factual, professional blog articles that:
- Are 950-1250 words
- Cite real data from DOE, Energy Star, NREL, or other credible sources with markdown links where available
- Include NC-specific context (Climate Zone 3A, local construction patterns, Triangle humidity)
- Mention Duke Energy Smart Saver rebates or the Energy Saver NC program where relevant
- Use clear H2 and H3 headings with short focused paragraphs
- Include a markdown table where it helps (costs, comparisons, specs)
- Include a Frequently Asked Questions section (H2) with 3-5 questions
- End with a short CTA paragraph that mentions Barrier Boss, (919) 971-9765, and mallettmade.co/contact
- Never use filler phrases like "it's important to note", "in conclusion", or "a crucial aspect"
- Naturally mention related Barrier Boss services where it genuinely helps the reader
- Do NOT include YAML front matter - start directly with the H1 title`;

async function main() {
  let lines = fs.readFileSync(queuePath, 'utf8').split('\n');
  let pendingIdx = findPending(lines);

  if (pendingIdx === -1) {
    const newRows = await generateNewTopics(lines);
    const updated = lines.join('\n').trimEnd() + '\n' + newRows.join('\n') + '\n';
    fs.writeFileSync(queuePath, updated, 'utf8');
    lines = updated.split('\n');
    pendingIdx = findPending(lines);

    if (pendingIdx === -1) {
      console.error('Failed to generate usable new topics.');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
      process.exit(0);
    }
  }

  // Parse: | # | Title | Category | Status | Sent | Published |
  const cols = lines[pendingIdx].split('|').map(s => s.trim());
  const num      = cols[1];
  const title    = cols[2];
  const category = cols[3];

  console.log(`Generating article #${num}: ${title} [${category}]`);

  const userPrompt = `Write a blog post for Barrier Boss titled: "${title}"

Category: ${category}

Write it for a Triangle NC homeowner who is researching this topic and deciding whether they need this service and what it costs. Make every sentence earn its place.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 16000,
    thinking: {
      type: 'adaptive'
    },
    output_config: {
      effort: 'high'
    },
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  const articleContent = textBlock.text;

  const today = new Date().toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  const articlePath = `articles-generated/${today}-${slug}.md`;
  const branch = `article/${slug}`;

  fs.writeFileSync(articlePath, articleContent, 'utf8');
  console.log(`Written: ${articlePath}`);

  lines[pendingIdx] = lines[pendingIdx]
    .replace(/\|\s*pending\s*\|/, '| in-review |')
    .replace(/\| in-review \|\s*\|/, `| in-review | ${today} |`);
  fs.writeFileSync(queuePath, lines.join('\n'), 'utf8');

  const repo = process.env.GITHUB_REPOSITORY || 'daggonit/radiant_forum';
  const articleUrl = `https://github.com/${repo}/blob/${branch}/${articlePath}`;
  const prBody = [
    `## Article #${num}: ${title}`,
    '',
    `Read the full article: ${articleUrl}`,
    '',
    'To approve: Merge this PR',
    'To request changes: Leave a comment, then ask Claude to revise it',
    '',
    'Quick checklist:',
    '- [ ] Headline is clear and accurate',
    '- [ ] No factual errors',
    '- [ ] Phone number correct: (919) 971-9765',
    '- [ ] CTA at the bottom is appropriate',
    '- [ ] No filler or AI-sounding phrases',
    '',
    'To publish in Squarespace after merging:',
    `1. Open ${articleUrl} - click Raw - copy all`,
    '2. Squarespace: New Blog Post - add Markdown block - paste - Publish',
  ].join('\n');
  fs.writeFileSync('.pr-body.md', prBody, 'utf8');

  const out = process.env.GITHUB_OUTPUT;
  fs.appendFileSync(out, `branch=${branch}\n`);
  fs.appendFileSync(out, `num=${num}\n`);
  fs.appendFileSync(out, `title=${title}\n`);
  fs.appendFileSync(out, `article_path=${articlePath}\n`);
  fs.appendFileSync(out, 'skip=false\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
