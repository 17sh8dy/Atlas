/**
 * Settings — a vertical-tab shell, one section per concern.
 *
 * Seven, not ten. Startup, Privacy and Default apps were placeholder pages —
 * a disabled switch and two paragraphs explaining that the thing they named
 * did not exist yet. Between them they held no control a person could
 * operate. A settings rail is a promise about what can be configured, and
 * three entries out of ten were breaking it; the roadmap belongs in
 * docs/ROADMAP.md, where it does not look like a feature.
 *
 * The one sentence worth keeping — that Atlas makes no network calls — moved
 * to About, where it reads as the fact it is rather than as an empty page.
 *
 * Vertical, not horizontal: the window's own `minWidth` (560px, see
 * `tauri.conf.json`) is tight for that many horizontal tab labels, and a
 * sidebar list scales cleanly as later phases add more sections without
 * needing a second row or a scrolling tab strip.
 */

import { Icons, Tabs, TabsContent, TabsList, TabsTrigger } from '@atlas/ui';
import type {
  CapabilityName,
  CloudProviderConfig,
  ExecutionMode,
  ListeningPreferences,
  Memory,
  Platform,
  SpeechPreferences,
  SpeechVoice,
  Storage,
  VoiceProfile,
} from '@atlas/core';
import type { CortexSettings } from '@atlas/data';
import type { SkillRegistry } from '@atlas/engine';
import { General } from './settings/General';
import { Appearance } from './settings/Appearance';
import { Voice } from './settings/Voice';
import { Personalization } from './settings/Personalization';
import { Activity } from './settings/Activity';
import { Notifications } from './settings/Notifications';
import { Intelligence } from './settings/Intelligence';
import { Account } from './settings/Account';
import { About } from './settings/About';

interface Props {
  platform: Platform;
  storage: Storage;
  capabilities: readonly CapabilityName[];
  skills: SkillRegistry;
  memory: Memory;
  executionMode: ExecutionMode;
  onExecutionModeChange(mode: ExecutionMode): void;
  voiceProfile: VoiceProfile;
  onVoiceProfileChange(): void;
  cortex: CortexSettings;
  activeProviderId: string | null;
  cloudProviders: CloudProviderConfig[];
  onProviderChange(): void;
  speechVoices: SpeechVoice[];
  speech: SpeechPreferences;
  onSpeechChange(next: Partial<SpeechPreferences>): void;
  onSpeechPreview(voiceId: string): void;
  onSpeechStop(): void;
  speechError: string | null;
  listening: ListeningPreferences;
  /** False in a build without the transcription engine. */
  listeningSupported: boolean;
  onListeningChange(next: Partial<ListeningPreferences>): void;
}

/**
 * The rail. Exported so a test can hold it against the panels that actually
 * exist — a tab whose content is missing renders an empty pane, which looks
 * exactly like a broken feature.
 */
export interface SettingsSection {
  id: string;
  label: string;
  icon: Icons.LucideIcon;
}

export const SECTIONS: readonly SettingsSection[] = [
  { id: 'general', label: 'General', icon: Icons.SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Icons.Palette },
  { id: 'voice', label: 'Voice', icon: Icons.Mic },
  { id: 'personalization', label: 'Personalization', icon: Icons.UserCircle },
  { id: 'activity', label: 'Activity', icon: Icons.Activity },
  { id: 'notifications', label: 'Notifications', icon: Icons.Bell },
  { id: 'intelligence', label: 'Intelligence', icon: Icons.Brain },
  /* Second to last, above About. Atlas is complete signed out, and an account entry near the
     top of a settings rail is how an optional thing starts reading as a required one. */
  { id: 'account', label: 'Account', icon: Icons.UserRound },
  { id: 'about', label: 'About', icon: Icons.Info },
];

export function Settings({
  platform,
  storage,
  capabilities,
  skills,
  memory,
  executionMode,
  onExecutionModeChange,
  voiceProfile,
  onVoiceProfileChange,
  cortex,
  activeProviderId,
  cloudProviders,
  onProviderChange,
  speechVoices,
  speech,
  onSpeechChange,
  onSpeechPreview,
  onSpeechStop,
  speechError,
  listening,
  listeningSupported,
  onListeningChange,
}: Props) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-foreground text-base font-semibold tracking-tight">Settings</h1>
        <p className="text-foreground-muted mt-1 text-sm">
          Everything optional lives here. Atlas is complete without any of it.
        </p>

        <Tabs defaultValue="general" orientation="vertical" className="mt-7 flex gap-8">
          <TabsList aria-label="Settings sections" className="w-44 shrink-0">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <TabsTrigger key={id} value={id}>
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-w-0 flex-1">
            <TabsContent value="general">
              <General
                platform={platform}
                capabilities={capabilities}
                skills={skills}
                executionMode={executionMode}
                onExecutionModeChange={onExecutionModeChange}
              />
            </TabsContent>
            <TabsContent value="appearance">
              <Appearance />
            </TabsContent>
            <TabsContent value="voice">
              <Voice
                voices={speechVoices}
                preferences={speech}
                onChange={onSpeechChange}
                onPreview={onSpeechPreview}
                onStop={onSpeechStop}
                error={speechError}
                listening={listening}
                listeningSupported={listeningSupported}
                onListeningChange={onListeningChange}
              />
            </TabsContent>
            <TabsContent value="personalization">
              <Personalization
                storage={storage}
                voiceProfile={voiceProfile}
                onVoiceProfileChange={onVoiceProfileChange}
              />
            </TabsContent>
            <TabsContent value="activity">
              <Activity memory={memory} />
            </TabsContent>
            <TabsContent value="notifications">
              <Notifications platform={platform} capabilities={capabilities} storage={storage} />
            </TabsContent>
            <TabsContent value="intelligence">
              <Intelligence
                storage={storage}
                cortex={cortex}
                activeProviderId={activeProviderId}
                cloudProviders={cloudProviders}
                onProviderChange={onProviderChange}
              />
            </TabsContent>
            <TabsContent value="account">
              <Account platform={platform} storage={storage} />
            </TabsContent>
            <TabsContent value="about">
              <About platform={platform} skillCount={skills.available().length} />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
