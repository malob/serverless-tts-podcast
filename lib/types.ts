import { VoiceSelectionParams } from '@google-cloud/text-to-speech'

// Aliases to make intention explicit
export type DirPath  = string
export type FilePath = string
export type Hash     = string
export type Url      = string


// Configurating file types 
export interface Config {
  readonly gcp: GcpConfig;
  readonly podcast: PodcastConfig;
}

export interface GcpConfig {
  readonly credentialsPath: FilePath;
  readonly project: string;
  readonly bucket: string;
  readonly parserPubSubTopic: string;
  readonly ttsPubSubTopic: string;
  readonly ttsCharLimit: number;
  readonly ttsOptions: GcpTtsConfig;
}

export interface GcpTtsConfig {
  readonly voice: VoiceSelectionParams;
}

export interface PodcastConfig {
  readonly title: string;
  readonly description: string;
  readonly siteUrl: Url;
  readonly author: string;
  readonly language: string;
}


// Standin types
// TODO: Look for actual type definition
export interface PubSubMessage {
  readonly data: string;
}


// TODO: Find actual type for this
export interface StorageEvent {
  name: string;
}
