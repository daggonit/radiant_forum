// Called by the weekly-article-pr workflow.
// Reads topic-queue.md, generates an article via Claude API, writes files to disk,
// and sets GitHub Actions step outputs for the commit/PR step.

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const queuePath = 'topic-queue.md';
const queueContent = fs.readFileSync(queuePath, 'utf8');
const lines = queueContent.split('\n');

// Find first pending topic
let pendingIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (/\|\s*pending\s*\|/.test(lines[i])) {
    pendingIdx = i;
    break;
  }
}

if (pendingIdx === -1) {
  console.log('No pending topics. Queue exhausted.');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
  process.exit(0);
}

// Parse: | # | Title | Category | Status | Sent | Published |
const cols = lines[pendingIdx].split('|').map(s => s.trim());
const num      = cols[1];
const title    = cols[2];
const category = cols[3];

console.log(`Generating article #${num}: ${title} [${category}]`);

const client = new Anthropic();

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

const userPrompt = `Write a blog post for Barrier Boss titled: "${title}"

Category: ${category}

Write it for a Triangle NC homeowner who is researching this topic and deciding whether they need this service and what it costs. Make every sentence earn its place.`;

async function main() {
  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 16000,
    thinking: {
      type: 'enabled',
      budget_tokens: 10000
    },
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  // Thinking responses return multiple content blocks; grab only the text block
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  const articleContent = textBlock.text;

  // Build file path and branch name from title slug
  const today = new Date().toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  const articlePath = `articles-generated/${today}-${slug}.md`;
  const branch = `article/${slug}`;

  // Write article to disk
  fs.writeFileSync(articlePath, articleContent, 'utf8');
  console.log(`Written: ${articlePath}`);

  // Mark topic as in-review in the queue
  const today2 = today;
  lines[pendingIdx] = lines[pendingIdx]
    .replace(/\|\s*pending\s*\|/, '| in-review |')
    .replace(/\| in-review \|\s*\|/, `| in-review | ${today2} |`);
  fs.writeFileSync(queuePath, lines.join('\n'), 'utf8');

  // Pass outputs to the next workflow step
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
