import { badRequest } from "@lyra/core";
import type { ChannelAdapter } from "@lyra/core";
import { whatsappCloudAdapter } from "./orbit-channel-whatsapp.js";
import { mailgunEmailAdapter } from "./orbit-channel-mailgun.js";
import { webchatAdapter } from "./orbit-channel-webchat.js";
import { voiceAdapter } from "./orbit-channel-voice.js";

const ADAPTERS: Record<string, ChannelAdapter> = {
  [whatsappCloudAdapter.provider]: whatsappCloudAdapter,
  [mailgunEmailAdapter.provider]: mailgunEmailAdapter,
  [webchatAdapter.provider]: webchatAdapter,
  [voiceAdapter.provider]: voiceAdapter
};

export function adapterFor(provider: string): ChannelAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw badRequest(`unknown channel provider: ${provider}`);
  return adapter;
}
