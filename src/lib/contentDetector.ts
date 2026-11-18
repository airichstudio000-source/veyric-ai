import type { ContentBlockType } from '../types/chat';

export type PromptKind =
  | 'image'
  | 'video'
  | 'text_to_video'
  | 'image_to_video'
  | 'general';

export interface ExtractedPrompt {
  id: string;
  kind: PromptKind;
  heading: string;
  promptText: string;
}

export interface ExtractedPromptDisplay {
  beforeText: string;
  prompts: ExtractedPrompt[];
  afterText: string;
}

export type StructuredContentType = Exclude<
  ContentBlockType,
  'image_prompt' | 'video_prompt'
>;

export interface ContentTypeMeta {
  type: StructuredContentType;
  label: string;
  filenamePrefix: string;
  fileExtension: 'md' | 'txt';
}

const CONTENT_TYPE_META: Record<StructuredContentType, ContentTypeMeta> = {
  video_script: {
    type: 'video_script',
    label: 'Video Script',
    filenamePrefix: 'veyric-video-script',
    fileExtension: 'md',
  },
  content_writing: {
    type: 'content_writing',
    label: 'Content Writing',
    filenamePrefix: 'veyric-content-draft',
    fileExtension: 'md',
  },
  storytelling: {
    type: 'storytelling',
    label: 'Storytelling',
    filenamePrefix: 'veyric-story',
    fileExtension: 'md',
  },
  social_caption: {
    type: 'social_caption',
    label: 'Social Media Caption',
    filenamePrefix: 'veyric-social-caption',
    fileExtension: 'txt',
  },
  marketing_copy: {
    type: 'marketing_copy',
    label: 'Marketing Copy',
    filenamePrefix: 'veyric-marketing-copy',
    fileExtension: 'md',
  },
  professional_email: {
    type: 'professional_email',
    label: 'Professional Email',
    filenamePrefix: 'veyric-email-draft',
    fileExtension: 'txt',
  },
};

export function getContentTypeMeta(type: StructuredContentType): ContentTypeMeta {
  return CONTENT_TYPE_META[type];
}

const EXPLANATORY_QUESTION_REGEX =
  /^(?:what\s+is|what\s+are|how\s+do|how\s+does|how\s+to\s+learn|why\s+is|why\s+do|explain\s+what|define|difference\s+between|can\s+you\s+explain)\b/i;

const CREATION_INTENT_REGEX =
  /(?:\b(?:write|draft|create|compose|craft|generate|make|give\s+me|turn\s+this\s+into|rewrite|improve|provide)\b|ရေးပေး|ဖန်တီးပေး|ပြုစုပေး|ထုတ်ပေး)/i;

function classifyPromptKind(text: string): { kind: PromptKind; heading: string } {
  if (/text[- ]?to[- ]?video/i.test(text)) {
    return { kind: 'text_to_video', heading: 'TEXT-TO-VIDEO PROMPT' };
  }
  if (/image[- ]?to[- ]?video/i.test(text)) {
    return { kind: 'image_to_video', heading: 'IMAGE-TO-VIDEO PROMPT' };
  }
  if (
    /\b(?:video\s+prompt|sora|runway|veo|kling|pika|luma)\b|ဗီဒီယို\s*prompt/i.test(text)
  ) {
    return { kind: 'video', heading: 'VIDEO PROMPT' };
  }
  if (
    /\b(?:image\s+prompt|midjourney|stable\s+diffusion|flux|dall[- ]?e|photo\s+prompt|thumbnail\s+prompt)\b|ပုံ\s*prompt/i.test(
      text
    )
  ) {
    return { kind: 'image', heading: 'IMAGE PROMPT' };
  }
  return { kind: 'general', heading: 'AI PROMPT' };
}

function isPromptRequest(userPrompt: string): boolean {
  const prompt = userPrompt.trim();
  if (!prompt || EXPLANATORY_QUESTION_REGEX.test(prompt)) {
    return false;
  }
  return (
    /\b(?:prompts?)\b/i.test(prompt) &&
    (CREATION_INTENT_REGEX.test(prompt) ||
      /\b(?:image|video|text-to-video|image-to-video|midjourney|sora|veo|runway|kling|flux|dall[- ]?e|system|chatgpt|ai)\b/i.test(
        prompt
      ))
  );
}

function cleanExtractedPromptText(raw: string): string {
  let cleaned = raw.trim();
  // Strip blockquote markers if prompt was formatted as a markdown blockquote
  if (cleaned.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('>'))) {
    cleaned = cleaned
      .split('\n')
      .map((line) => line.replace(/^\s*>\s?/, ''))
      .join('\n')
      .trim();
  }
  // Strip surrounding outer quotes if the entire prompt is wrapped in matching quotes
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith('“') && cleaned.endsWith('”'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

const LEAD_IN_LINE_REGEX =
  /^(?:here(?:'s| is| are)\b.*:|sure[,!.]?\s*here\b.*:|certainly[,!.]?\s*here\b.*:|below is\b.*:|you can use (?:this|the following)\b.*:|အောက်ပါ\s*prompt\b.*:|ဒီမှာ\s*.*:)$/i;

const TRAILING_NOTE_LINE_REGEX =
  /^(?:#{1,3}\s*)?(?:\*\*)?(?:tips|notes?|how to use|key details|parameters|suggested settings|explanation|optional variations)\b/i;

/**
 * Extracts dedicated AI prompt(s) cleanly from surrounding conversational intro/notes
 * so Copy Prompt copies ONLY the prompt text itself.
 */
export function extractPromptDisplay(
  userPrompt: string,
  assistantContent: string,
  isStreaming: boolean
): ExtractedPromptDisplay | null {
  if (isStreaming) {
    return null;
  }

  const content = assistantContent.trim();
  if (content.length < 30) {
    return null;
  }

  const userAskedForPrompt = isPromptRequest(userPrompt);
  const contentHasExplicitPromptHeader =
    /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\*\*)?(?:image\s+prompt|video\s+prompt|text[- ]?to[- ]?video\s+prompt|image[- ]?to[- ]?video\s+prompt|ai\s+prompt|prompt(?:\s*\d+)?)\s*(?:\*\*)?\s*:?\s*(?:\n|$)/i.test(
      content
    );

  if (!userAskedForPrompt && !contentHasExplicitPromptHeader) {
    return null;
  }

  // Never hijack explanatory answers about what prompts are
  if (EXPLANATORY_QUESTION_REGEX.test(userPrompt.trim())) {
    return null;
  }

  const defaultKind = classifyPromptKind(`${userPrompt}\n${content}`);

  // 1. Check for fenced code blocks containing prompts (e.g., ```prompt ... ``` or ```text ... ```)
  const fenceRegex = /```(?:prompt|text|markdown|txt)?\s*\n([\s\S]*?)```/g;
  const fenceMatches = Array.from(content.matchAll(fenceRegex));
  if (fenceMatches.length > 0) {
    const prompts: ExtractedPrompt[] = [];
    let firstStart = fenceMatches[0].index ?? 0;
    let lastEnd = 0;

    fenceMatches.forEach((match, idx) => {
      const inner = cleanExtractedPromptText(match[1] ?? '');
      if (!inner) return;
      const matchStart = match.index ?? 0;
      const lookback = content.slice(Math.max(0, matchStart - 140), matchStart);
      const localKind = classifyPromptKind(`${lookback}\n${userPrompt}`);
      prompts.push({
        id: `prompt-${idx}`,
        kind: localKind.kind,
        heading:
          fenceMatches.length > 1
            ? `${localKind.heading} ${idx + 1}`
            : localKind.heading,
        promptText: inner,
      });
      lastEnd = matchStart + match[0].length;
    });

    if (prompts.length > 0) {
      let beforeText = content.slice(0, firstStart).trim();
      // Remove redundant trailing prompt heading immediately before the code fence
      beforeText = beforeText
        .replace(
          /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\*\*)?(?:(?:image|video|text[- ]?to[- ]?video|image[- ]?to[- ]?video|ai)\s+)?prompt(?:\s*\d+)?(?:\*\*)?\s*:?\s*$/i,
          ''
        )
        .trim();
      const afterText = content.slice(lastEnd).trim();
      return { beforeText, prompts, afterText };
    }
  }

  // 2. Check for explicitly labeled prompt sections (e.g., **Video Prompt:** or ### Image Prompt)
  const lines = content.split('\n');
  const headerIndices: Array<{ index: number; labelText: string; inlineBody: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(
      /^(?:#{1,3}\s*)?(?:\*\*)?((?:(?:image|video|text[- ]?to[- ]?video|image[- ]?to[- ]?video|ai)\s+)?prompt(?:\s*\d+)?(?:\s*\([^)]+\))?)(?:\*\*)?\s*:\s*(.*)$/i
    );
    const headingOnlyMatch =
      !match &&
      line.match(
        /^(?:#{1,3}\s+|\*\*)((?:(?:image|video|text[- ]?to[- ]?video|image[- ]?to[- ]?video|ai)\s+)?prompt(?:\s*\d+)?(?:\s*\([^)]+\))?)(?:\*\*)?$/i
      );

    if (match) {
      headerIndices.push({
        index: i,
        labelText: match[1].trim(),
        inlineBody: (match[2] ?? '').trim(),
      });
    } else if (headingOnlyMatch) {
      headerIndices.push({
        index: i,
        labelText: headingOnlyMatch[1].trim(),
        inlineBody: '',
      });
    }
  }

  if (headerIndices.length > 0) {
    const beforeText = lines.slice(0, headerIndices[0].index).join('\n').trim();
    const prompts: ExtractedPrompt[] = [];
    let trailingStartIndex = lines.length;

    for (let h = 0; h < headerIndices.length; h++) {
      const current = headerIndices[h];
      const nextHeaderIdx =
        h + 1 < headerIndices.length ? headerIndices[h + 1].index : lines.length;

      const bodyLines: string[] = [];
      if (current.inlineBody) {
        bodyLines.push(current.inlineBody);
      }

      for (let j = current.index + 1; j < nextHeaderIdx; j++) {
        const trimmedLine = lines[j].trim();
        if (TRAILING_NOTE_LINE_REGEX.test(trimmedLine)) {
          trailingStartIndex = Math.min(trailingStartIndex, j);
          break;
        }
        // Stop collecting if a blank line is followed by conversational notes/bullet tips
        if (
          bodyLines.length > 0 &&
          trimmedLine === '' &&
          j + 1 < nextHeaderIdx &&
          TRAILING_NOTE_LINE_REGEX.test(lines[j + 1].trim())
        ) {
          trailingStartIndex = Math.min(trailingStartIndex, j + 1);
          break;
        }
        bodyLines.push(lines[j]);
      }

      const promptText = cleanExtractedPromptText(bodyLines.join('\n'));
      if (promptText) {
        const kindInfo = classifyPromptKind(`${current.labelText}\n${userPrompt}`);
        prompts.push({
          id: `prompt-${h}`,
          kind: kindInfo.kind,
          heading:
            headerIndices.length > 1
              ? `${kindInfo.heading} ${h + 1}`
              : kindInfo.heading,
          promptText,
        });
      }
    }

    if (prompts.length > 0) {
      const afterText =
        trailingStartIndex < lines.length
          ? lines.slice(trailingStartIndex).join('\n').trim()
          : '';
      return { beforeText, prompts, afterText };
    }
  }

  // 3. Fallback when user explicitly asked for a prompt: strip conversational lead-in / trailing tips
  if (userAskedForPrompt) {
    const nonEmptyParagraphs = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (nonEmptyParagraphs.length === 1) {
      return {
        beforeText: '',
        prompts: [
          {
            id: 'prompt-0',
            kind: defaultKind.kind,
            heading: defaultKind.heading,
            promptText: cleanExtractedPromptText(nonEmptyParagraphs[0]),
          },
        ],
        afterText: '',
      };
    }

    let startIdx = 0;
    let endIdx = nonEmptyParagraphs.length;

    if (LEAD_IN_LINE_REGEX.test(nonEmptyParagraphs[0])) {
      startIdx = 1;
    }
    if (
      endIdx - startIdx > 1 &&
      TRAILING_NOTE_LINE_REGEX.test(nonEmptyParagraphs[endIdx - 1])
    ) {
      endIdx -= 1;
    }

    const promptBody = cleanExtractedPromptText(
      nonEmptyParagraphs.slice(startIdx, endIdx).join('\n\n')
    );
    if (promptBody) {
      return {
        beforeText: nonEmptyParagraphs.slice(0, startIdx).join('\n\n'),
        prompts: [
          {
            id: 'prompt-0',
            kind: defaultKind.kind,
            heading: defaultKind.heading,
            promptText: promptBody,
          },
        ],
        afterText: nonEmptyParagraphs.slice(endIdx).join('\n\n'),
      };
    }
  }

  return null;
}

const STRUCTURAL_DELIVERABLE_REGEX: Array<{
  type: StructuredContentType;
  promptPattern: RegExp;
}> = [
  {
    type: 'video_script',
    promptPattern:
      /\b(?:video\s+script|youtube\s+script|tiktok\s+script|reel\s+script|short\s+script|screenplay|script\s+for\s+(?:a\s+)?(?:video|reel|tiktok|youtube|short))\b|ဗီဒီယို\s*စခရစ်/i,
  },
  {
    type: 'professional_email',
    promptPattern:
      /\b(?:professional\s+email|formal\s+email|business\s+email|cold\s+email|follow[- ]?up\s+email|cover\s+email|email\s+(?:to|for)|draft\s+(?:an?\s+)?email|write\s+(?:an?\s+)?email)\b|အီးမေးလ်/i,
  },
  {
    type: 'social_caption',
    promptPattern:
      /\b(?:social\s+media\s+caption|instagram\s+caption|facebook\s+caption|tiktok\s+caption|linkedin\s+post|caption\s+for|social\s+post)\b|ကပ်ရှင်း/i,
  },
  {
    type: 'marketing_copy',
    promptPattern:
      /\b(?:marketing\s+copy|ad\s+copy|sales\s+copy|landing\s+page\s+copy|product\s+description|promotional\s+copy|headline\s+and\s+cta)\b/i,
  },
  {
    type: 'storytelling',
    promptPattern:
      /\b(?:short\s+story|storytelling|bedtime\s+story|narrative\s+story|tell\s+(?:me\s+)?a\s+story|write\s+(?:a\s+)?story)\b|ပုံပြင်|ဝတ္ထုတို/i,
  },
  {
    type: 'content_writing',
    promptPattern:
      /\b(?:blog\s+post|article\s+about|essay\s+on|newsletter|content\s+writing|long[- ]?form\s+post|write\s+(?:an?\s+)?article)\b|ဆောင်းပါး/i,
  },
];

/**
 * Identifies structured content writing, scripts, and professional emails
 * (distinct from Prompt Cards and normal conversational bubbles).
 */
export function detectContentBlockType(
  userPrompt: string,
  assistantContent: string,
  isStreaming: boolean
): StructuredContentType | null {
  const prompt = userPrompt.trim();
  const content = assistantContent.trim();

  if (!prompt || EXPLANATORY_QUESTION_REGEX.test(prompt) || isPromptRequest(prompt)) {
    return null;
  }

  if (isStreaming) {
    if (!CREATION_INTENT_REGEX.test(prompt)) {
      return null;
    }
    for (const rule of STRUCTURAL_DELIVERABLE_REGEX) {
      if (rule.promptPattern.test(prompt)) {
        return rule.type;
      }
    }
    return null;
  }

  if (content.length < 90) {
    return null;
  }
  if (content.length < 220 && content.endsWith('?') && !content.includes('\n')) {
    return null;
  }

  const hasCreationIntent = CREATION_INTENT_REGEX.test(prompt);
  for (const rule of STRUCTURAL_DELIVERABLE_REGEX) {
    if (
      rule.promptPattern.test(prompt) &&
      (hasCreationIntent || !EXPLANATORY_QUESTION_REGEX.test(prompt))
    ) {
      return rule.type;
    }
  }

  if (
    /(?:^|\n)\s*(?:\*\*)?subject\s*:/i.test(content) &&
    /(?:dear|hi|hello|regards|sincerely|best)\b/i.test(content)
  ) {
    return 'professional_email';
  }
  if (
    /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\*\*)?(?:hook|scene\s*1|voiceover)\b/i.test(content) &&
    /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\*\*)?(?:body|scene\s*2|outro|call\s+to\s+action|cta)\b/i.test(
      content
    )
  ) {
    return 'video_script';
  }

  return null;
}

export interface ContentSection {
  id: string;
  title: string;
  body: string;
}

export function parseContentSections(content: string): ContentSection[] {
  const lines = content.split('\n');
  const sections: ContentSection[] = [];
  let currentTitle = '';
  let currentLines: string[] = [];
  let insideFence = false;

  const pushCurrent = () => {
    const body = currentLines.join('\n').trim();
    if (currentTitle && body) {
      sections.push({
        id: `sec-${sections.length}-${currentTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        title: currentTitle,
        body,
      });
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      insideFence = !insideFence;
      currentLines.push(line);
      continue;
    }

    if (!insideFence) {
      const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
      const boldHeaderMatch =
        !headingMatch &&
        line.match(/^\*\*([^*]{2,55})\*\*\s*(?::\s*(.*))?$/) &&
        !line.includes('Subject:');

      if (headingMatch) {
        pushCurrent();
        currentTitle = headingMatch[1].replace(/\*\*/g, '').trim();
        currentLines = [];
        continue;
      }

      if (boldHeaderMatch) {
        const match = line.match(/^\*\*([^*]{2,55})\*\*\s*(?::\s*(.*))?$/);
        if (match) {
          pushCurrent();
          currentTitle = match[1].trim();
          currentLines = match[2] ? [match[2]] : [];
          continue;
        }
      }
    }

    currentLines.push(line);
  }

  pushCurrent();

  return sections.length >= 2 ? sections : [];
}
