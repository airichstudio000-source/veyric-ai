import { ArrowUpRight, FileText, Globe, Languages } from 'lucide-react';
import { GlassBrandLogo } from './GlassBrandLogo';

interface StarterPrompt {
  title: string;
  description: string;
  prompt: string;
  webSearch: boolean;
  icon: 'search' | 'language' | 'document';
}

const STARTER_PROMPTS: StarterPrompt[] = [
  {
    title: 'Current web research',
    description: 'Search live sources with verifiable links and citations',
    prompt: 'What are the most significant developments in clean energy storage this year? Include sources.',
    webSearch: true,
    icon: 'search',
  },
  {
    title: 'Burmese & English fluency',
    description: 'မြန်မာဘာသာဖြင့် တိုက်ရိုက်မေးမြန်းဆွေးနွေးနိုင်ပါသည်',
    prompt: 'မြန်မာဘာသာဖြင့် နေ့စဉ်အလုပ်လုပ်ရာတွင် အချိန်စီမံခန့်ခွဲမှု ပိုမိုကောင်းမွန်စေမည့် လက်တွေ့နည်းလမ်း ၅ ခုကို ရှင်းပြပေးပါ။',
    webSearch: false,
    icon: 'language',
  },
  {
    title: 'Code & architecture review',
    description: 'Clean structured reasoning, debugging, and technical drafts',
    prompt: 'Design a clean TypeScript rate limiter using a sliding window algorithm and explain the edge cases.',
    webSearch: false,
    icon: 'document',
  },
  {
    title: 'Analyze uploaded files',
    description: 'Attach images, videos, PDFs, TXT, or DOCX documents below',
    prompt: 'What file formats can I attach here, and how can you help analyze reports, screenshots, or videos?',
    webSearch: false,
    icon: 'document',
  },
];

interface WelcomeScreenProps {
  onSelectPrompt: (prompt: string, enableWebSearch: boolean) => void;
}

export function WelcomeScreen({ onSelectPrompt }: WelcomeScreenProps) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-8 sm:px-6">
      <div className="glass-panel rounded-3xl p-6 sm:p-10">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <GlassBrandLogo size={44} className="shrink-0" />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-white text-balance sm:text-3xl">
              Welcome to VEYRIC AI
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-white/85 sm:text-[15px]">
              Ask questions in English or Burmese, verify current facts with live web search, or attach images, videos, and documents for analysis.
            </p>
          </div>
        </div>

        <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {STARTER_PROMPTS.map((item) => (
            <button
              key={item.title}
              type="button"
              onClick={() => onSelectPrompt(item.prompt, item.webSearch)}
              className="glass-surface group flex min-h-[84px] flex-col justify-between rounded-2xl p-4 text-left transition-all duration-200 hover:border-white/60 hover:bg-white/[0.16] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <div className="flex w-full items-start justify-between gap-2">
                <span className="font-display text-sm font-medium text-white">
                  {item.title}
                </span>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/[0.14] text-white/85 transition-colors group-hover:bg-white/25 group-hover:text-white">
                  {item.icon === 'search' ? (
                    <Globe className="h-3.5 w-3.5" />
                  ) : item.icon === 'language' ? (
                    <Languages className="h-3.5 w-3.5" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                </span>
              </div>
              <div className="mt-2 flex items-end justify-between gap-2">
                <span className="text-xs leading-relaxed text-white/80">
                  {item.description}
                </span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-white/70 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-white" />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
