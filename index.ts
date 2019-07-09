// Google APIs used throught
import { Storage } from '@google-cloud/storage'
import { VoiceSelectionParams } from '@google-cloud/text-to-speech'

// Functional programming tools
import { pipe } from 'fp-ts/lib/pipeable'
import { flow } from 'fp-ts/lib/function'
import { sequenceT } from 'fp-ts/lib/Apply'
import * as A from 'fp-ts/lib/Array'
import { log, error } from 'fp-ts/lib/Console'
import * as E from 'fp-ts/lib/Either'
import * as NEA from 'fp-ts/lib/NonEmptyArray'
import { NonEmptyArray as NEArray } from 'fp-ts/lib/NonEmptyArray'
import * as TE from 'fp-ts/lib/TaskEither'
import { snd } from 'fp-ts/lib/Tuple'

// Other imports used throught
import Mercury from '@postlight/mercury-parser'
import * as config from './config.json'
const conf = config as Config

// Type aliases used throught
type DirPath  = string
type FilePath = string
type Hash     = string
type Url      = string

// Interfaces used throught
interface Config {
  readonly gcp: GcpConfig;
  readonly podcast: PodcastConfig;
}

interface GcpConfig {
  readonly credentialsPath: FilePath;
  readonly project: string;
  readonly bucket: string;
  readonly parserPubSubTopic: string;
  readonly ttsPubSubTopic: string;
  readonly ttsCharLimit: number;
  readonly ttsOptions: GcpTtsConfig;
}

interface GcpTtsConfig {
  readonly voice: VoiceSelectionParams;
}

interface PodcastConfig {
  readonly title: string;
  readonly description: string;
  readonly siteUrl: Url;
  readonly author: string;
  readonly language: string;
}

// TODO: Look for actual type definition
interface PubSubMessage {
  readonly data: string;
}

// Small helper functions
const base64Decode               = (s: string): string => Buffer.from(s, 'base64').toString()
const traverseArrayTE            = A.array.traverse(TE.taskEither)
const traverseNEArrayTE          = NEA.nonEmptyArray.traverse(TE.taskEither)
const traverseNEArrayWithIndexTE = NEA.nonEmptyArray.traverseWithIndex(TE.taskEither)

// -------------------------------------------------------------------------------------------------
// Web article/post content and metadata extraction
// -------------------------------------------------------------------------------------------------

// Specific imports for this cloud function
import { PubSub, Topic } from '@google-cloud/pubsub'
import * as htmlToText from 'html-to-text'

// Error type for this cloud funuction
type ParseError =
  'MercuryParser'
  | 'EmptyBody'
  | 'PubSub'

// Cloud function triggered by a PubSubMessage that recieves a url and returns content and metadata.
export const parseWebpage = async (m: PubSubMessage): Promise<void> => {
  // Let
  const url: Url        = base64Decode(m.data)
  const pubsub: Topic   = (new PubSub()).topic(conf.gcp.ttsPubSubTopic)
  const contentToBuffer = (x: Mercury.ParseResult): Buffer => Buffer.from(JSON.stringify(x))

  // In
  log(`Parsing content of: ${url}`)()
  await pipe(
    TE.tryCatch( () => Mercury.parse(url), (): ParseError => 'MercuryParser' ),
    TE.chain   ( c  => c.content ? TE.right(c) : TE.left<ParseError>('EmptyBody') ),
    TE.map     ( flow(processMercuryResult, contentToBuffer) ),
    TE.chain   ( b  => TE.tryCatch(() => pubsub.publish(b), (): ParseError => 'PubSub') ),
  )()
    .then(x => pipe( x, E.fold(
      e => {
        switch(e) {
        case 'MercuryParser': error('Error while trying to parse webpage.')(); break
        case 'EmptyBody'    : error('Error, no body content returned by parser.')(); break
        case 'PubSub'       : error('Error, failed to send message to TTS function.')(); break
        default             : error('Somehow and error occured that wasn\'t accounted for.')()
        }
      },
      () => {}
    )))
}

// Helper function to prcoess consent into needed form
const processMercuryResult = (x: Mercury.ParseResult): Mercury.ParseResult => {
  // Let
  const htmlToTextOptions: HtmlToTextOptions =
    { wordwrap               : null
    , ignoreHref             : true
    , ignoreImage            : true
    , preserveNewlines       : false
    , uppercaseHeadings      : false
    , singleNewLineParagraphs: false
    }
  const date: Date = x.date_published ? new Date(x.date_published) : new Date()
  const newContent: string =
    (x.title          ? `${x.title}\n\n`                           : '') +
    (x.author         ? `By: ${x.author}\n\n`                      : '') +
    (x.date_published ? `Published on: ${date.toDateString()}\n\n` : '') +
    (x.domain         ? `Published at: ${x.domain}\n\n`            : '') +
    htmlToText.fromString(x.content as string, htmlToTextOptions)
  const out = Object.assign({}, x)

  // In
  out.content = newContent
  return out
}

// -------------------------------------------------------------------------------------------------
// Text to speech conversion
// -------------------------------------------------------------------------------------------------

// Specific imports for this cloud function
import { createHash } from 'crypto'
import { mkdir, writeFile } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

import { UploadOptions, UploadResponse} from '@google-cloud/storage'
import TextToSpeech from '@google-cloud/text-to-speech'
import { SynthesizeSpeechRequest, SynthesizeSpeechResponse as TtsResponse } from '@google-cloud/text-to-speech'

const chunkText = require('chunk-text') //eslint-disable-line
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import rmrf from 'rimraf'

// Error type for this cloud function
type TtsError =
  'RmWorkingDir'
  | 'MkWoringDir'
  | 'TTSConversion'
  | 'WriteAudioChuck'
  | 'ConcatAudioChunks'
  | 'BucketWrite'

// Small helper functions for this cloud function
const stringToHash = (s: string): Hash => createHash('md5').update(s).digest('hex')

// Cloud function triggered by PubSub message that receives consent and metadata and creates TTS audio file.
export const textToSpeech = async (m: PubSubMessage): Promise<void> => {
  // Let
  const contentData: Mercury.ParseResult = JSON.parse(base64Decode(m.data))
  const chunkedContent: NEArray<string>  = chunkText(contentData.content, conf.gcp.ttsCharLimit)
  const workingDirName: string           = stringToHash(contentData.url)
  const workingDirPath: DirPath          = path.join(tmpdir(), workingDirName)

  const removeWorkingDir = (): TE.TaskEither<TtsError, void> =>
    TE.tryCatch( () => promisify(rmrf)(workingDirPath), (): TtsError => 'RmWorkingDir' )
  const createWorkingDir = (): TE.TaskEither<TtsError, void> =>
    TE.tryCatch( () => promisify(mkdir)(workingDirPath), (): TtsError => 'MkWoringDir' )
  const writeAudioChunks =
    (xs: NEArray<TtsResponse>): TE.TaskEither<TtsError, NEArray<FilePath>> =>
      traverseNEArrayWithIndexTE(xs, (i, x) => writeAudioChunk(workingDirPath, i, x))

  // In
  await pipe(
    sequenceT(TE.taskEither)(
      pipe             ( removeWorkingDir(), TE.chain(() => createWorkingDir()) ),
      traverseNEArrayTE( chunkedContent, getTtsAudio )
    ),
    TE.chain( t   => writeAudioChunks(snd(t)) ),
    TE.chain( fps => concatAudioChunks(fps, workingDirPath) ),
    TE.chain( fp  => createGcsObject(fp, contentData) )
  )()
    .then(x => pipe( x, E.fold(
      e => {
        switch(e) {
        case 'RmWorkingDir'     : error('Error while trying to remove old working directory.')(); break
        case 'MkWoringDir'      : error('Error creating working directory.')(); break
        case 'TTSConversion'    : error('Error during TTS conversion step.')(); break
        case 'WriteAudioChuck'  : error('Error writing an audio chunk to disk.')(); break
        case 'ConcatAudioChunks': error('Error concatinating audio chunk.')(); break
        case 'BucketWrite'      : error('Error writing file to bucket.')(); break
        default                 : error('Somehow and error occured that wasn\'t accounted for.')()
        }
      },
      () => {}
    )))
    .then( () => removeWorkingDir()() )
    .then( x  => pipe( x, E.fold( () => error('Error cleaning up working directory')(), () => {} )) )
}

// Helper function that creates creates a TaskEither to convert a string to audio.
const getTtsAudio = (s: string): TE.TaskEither<TtsError, TtsResponse> => {
  // Let
  const ttsClient = new TextToSpeech.TextToSpeechClient()
  const ttsRequest: SynthesizeSpeechRequest =
    { input      : { text: s }
    , voice      : conf.gcp.ttsOptions.voice
    , audioConfig: { audioEncoding: 'MP3', effectsProfileId: ['headphone-class-device'] }
    }

  // In
  return pipe(
    TE.tryCatch( () => ttsClient.synthesizeSpeech(ttsRequest), (): TtsError => 'TTSConversion' ),
    TE.map     ( ([x]) => x )
  )
}

// Helper function that creates a TaskEither to write an audio chunck to disk
const writeAudioChunk = (d: DirPath, i: number, a: TtsResponse): TE.TaskEither<TtsError, FilePath> => {
  // Let
  const fp: FilePath = path.join(d, `${i}.mp3`)

  // In
  return pipe(
    TE.tryCatch( () => promisify(writeFile)(fp, a.audioContent, 'binary'), (): TtsError => 'WriteAudioChuck' ),
    TE.map     ( () => fp)
  )
}

// Helper function that creates a TaskEither that concatinates audio chunks and writes the file to disk.
const concatAudioChunks = (fps: NEArray<FilePath>, d: DirPath): TE.TaskEither<TtsError, FilePath> => {
  if (fps.length == 1) {
    return TE.taskEither.of(NEA.head(fps))
  }
  else {
    // Let
    const fp: FilePath = path.join(d, 'audio.mp3')
    const ffmpegCmd = ffmpeg()
    fps.forEach(x => ffmpegCmd.input(x))
    const ffmpegPromise = new Promise<string>((resolve, reject) => {
      ffmpegCmd
        .setFfmpegPath(ffmpegStatic.path)
        .setFfprobePath(ffprobeStatic.path)
        .on('error', err => reject(Error(err)))
        .on('end'  , ()  => resolve(fp))
        .mergeToFile(fp)
    })

    // In
    return TE.tryCatch( () => ffmpegPromise, (): TtsError => 'ConcatAudioChunks' )
  }
}

// Helper function that creates a TaskEither that writes the audio file to GCS
const createGcsObject = (fp: FilePath, c: Mercury.ParseResult): TE.TaskEither<TtsError, UploadResponse> => {
  // Let
  const bucket = (new Storage()).bucket(conf.gcp.bucket)
  const hash = stringToHash(c.url)
  const objectOptions: UploadOptions =
    { destination: hash + '.mp3'
    , public     : true
    , metadata   :
      { contentType: 'audio/mpeg'
      , metadata   :
        { title        : c.title
        , author       : c.author
        , excerpt      : c.excerpt
        , url          : c.url
        , datePublished: c.date_published
        , leadImageUrl : c.lead_image_url
        }
      }
    }

  // In
  return TE.tryCatch( () => bucket.upload(fp, objectOptions), (): TtsError => 'BucketWrite' )
}

// -------------------------------------------------------------------------------------------------
// Podcast feed generation
// -------------------------------------------------------------------------------------------------

// Specific imports for this cloud function
import { Metadata } from '@google-cloud/common'
import { GetFileMetadataResponse, GetFilesResponse } from '@google-cloud/storage'
import Podcast from 'podcast'

// Specific types for this cloud function
// TODO: Find actual type for this
interface StorageEvent {
  name: string;
}

// Error type for this cloud function
type PodcastError =
  'GetBucketObjects'
  | 'GetObjectMeta'
  | 'RSSFileWrite'

// Cloud function triggered by bucket update that generate the podcast RSS.
export const generatePodcastRss = async (event: StorageEvent ): Promise<void> => {
  // Let
  const bucket         = (new Storage()).bucket(conf.gcp.bucket)
  const rssFileName    = 'podcast.xml'
  const rssFileOptions = { public: true, contentType: 'application/rss+xml' }
  const feedOptions: Podcast.FeedOptions =
    { ...conf.podcast
    , feedUrl: 'http://storage.googleapis.com/' + conf.gcp.bucket + '/' + rssFileName
    , ttl    : 1
    }

  const getFilesFromBucket = (): TE.TaskEither<PodcastError, GetFilesResponse> =>
    TE.tryCatch( () => bucket.getFiles(), (): PodcastError => 'GetBucketObjects' )
  const getFilesMetadata = ([r]: GetFilesResponse): TE.TaskEither<PodcastError, GetFileMetadataResponse[]> =>
    traverseArrayTE(r, f => TE.tryCatch( () => f.getMetadata(), (): PodcastError => 'GetObjectMeta'))
  const writeFeedToBucket = (f: string): TE.TaskEither<PodcastError, void> =>
    TE.tryCatch( () => bucket.file(rssFileName).save(f, rssFileOptions), (): PodcastError => 'RSSFileWrite')

  // In
  if (event.name == rssFileName) {
    log('False alarm, it was just the RSS feed being updated.')()
    return
  }

  await pipe(
    getFilesFromBucket(),
    TE.chain   ( getFilesMetadata ),
    TE.map     ( ms => A.array.filter(ms, ([x]) => x.contentType == 'audio/mpeg') ),
    TE.map     ( ms => ms.map(createRssItem) ),
    TE.map     ( is => (new Podcast(feedOptions, is)).buildXml(true) ),
    TE.chain   ( writeFeedToBucket )
  )()
    .then(x => pipe( x, E.fold(
      e => {
        switch(e) {
        case 'GetBucketObjects': error('Error retriving objects from bucket.')(); break
        case 'GetObjectMeta'   : error('Error retriving object metadata.')(); break
        case 'RSSFileWrite'    : error('Error writing RSS feed file to bucket.')(); break
        default                : error('Somehow and error occured that wasn\'t accounted for.')
        }
      },
      () => {}
    )))
}

// Helper function to create each item of RSS feed
const createRssItem = ([m]: Metadata): Podcast.Item => {
  return (
    { title      : m.metadata.title
    , description: `Excerpt: ${m.metadata.excerpt}`
    , url        : m.metadata.url
    , author     : m.metadata.author
    , enclosure  :
      { url : `http://storage.googleapis.com/${m.bucket}/${m.name}`
      , size: m.size
      }
    , date       : m.timeCreated
    , itunesImage: m.metadata.leadImageUrl
    }
  )
}
