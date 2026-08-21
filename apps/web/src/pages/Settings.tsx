/**
 * Settings — a vertical-tab shell around ten sections.
 *
 * Vertical, not horizontal: the window's own `minWidth` (560px, see
 * `tauri.conf.json`) is tight for that many horizontal tab labels, and a
 * sidebar list scales cleanly as later phases add more sections without
 * needing a second row or a scrolling tab strip.
 */

import { Icons, Tabs, TabsContent, TabsList, TabsTrigger } from '@atlas/ui';
import type {
  CapabilityName,
  ListeningPreferences,
  Platform,
  SpeechPreferences,
  SpeechVoice,
  Storage,
  VoiceProfile,
} from '@atlas/core';
import type { ProviderKeyId } from '@atlas/data';
import type { SkillRegistry } from '@atlas/engine';
import { General } from './settings/General';
import { Appearance } from './settings/Appearance';
import { Voice } from './settings/Voice';
import { Personalization } from './settings/Personalization';
import { Startup } from './settings/Startup';
import { Notifications } from './settings/Notifications';
import { Privacy } from './settings/Privacy';
import { DefaultApps } from './settings/DefaultApps';
import { Developer } from './settings/Developer';
import { About } from './settings/About';

interface Props {
  platform: Platform;
  storage: Storage;
  capabilities: readonly CapabilityName[];
  skills: SkillRegistry;
  voiceProfile: VoiceProfile;
  onVoiceProfileChange(): void;
  providerKeys: Partial<Record<ProviderKeyId, string>>;
  activeProviderId: string | null;
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

const SECTIONS = [
  { id: 'general', label: 'General', icon: Icons.SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Icons.Palette },
  { id: 'voice', label: 'Voice', icon: Icons.Mic },
  { id: 'personalization', label: 'Personalization', icon: Icons.UserCircle },
  { id: 'startup', label: 'Startup', icon: Icons.Power },
  { id: 'notifications', label: 'Notifications', icon: Icons.Bell },
  { id: 'privacy', label: 'Privacy', icon: Icons.Lock },
  { id: 'default-apps', label: 'Default apps', icon: Icons.AppWindow },
  { id: 'developer', label: 'Developer', icon: Icons.Cpu },
  { id: 'about', label: 'About', icon: Icons.Info },
] as const;

export function Settings({
  platform,
  storage,
  capabilities,
  skills,
  voiceProfile,
  onVoiceProfileChange,
  providerKeys,
  activeProviderId,
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
              <General platform={platform} capabilities={capabilities} skills={skills} />
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
            <TabsContent value="startup">
              <Startup />
            </TabsContent>
            <TabsContent value="notifications">
              <Notifications platform={platform} capabilities={capabilities} storage={storage} />
            </TabsContent>
            <TabsContent value="privacy">
              <Privacy />
            </TabsContent>
            <TabsContent value="default-apps">
              <DefaultApps />
            </TabsContent>
            <TabsContent value="developer">
              <Developer
                storage={storage}
                providerKeys={providerKeys}
                activeProviderId={activeProviderId}
                onProviderChange={onProviderChange}
              />
            </TabsContent>
            <TabsContent value="about">
              <About platform={platform} />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
