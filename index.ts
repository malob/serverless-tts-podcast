// Node imports
import { createHash } from 'crypto'
import { mkdir, writeFile } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

// Google APIs used throught
import { PubSub, Topic } from '@google-cloud/pubsub'
import { Storage, UploadOptions, UploadResponse} from '@google-cloud/storage'
import { Metadata } from '@google-cloud/common'

// Functional programming tools
import { pipe } from 'fp-ts/lib/pipeable'
import { flow } from 'fp-ts/lib/function'
import { sequenceT } from 'fp-ts/lib/Apply'
import * as A from 'fp-ts/lib/Array'
import { error } from 'fp-ts/lib/Console'
import * as E from 'fp-ts/lib/Either'
import * as NEA from 'fp-ts/lib/NonEmptyArray'
import * as TE from 'fp-ts/lib/TaskEither'
import { snd } from 'fp-ts/lib/Tuple'

// Other imports used throught
import Mercury from '@postlight/mercury-parser'
import * as config from './config.json'

// Interfaces used throught
// TODO: Look for actual type definition
interface PubSubMessage {
  data: string;
}

// Type aliases used throught
type DirPath    = string
type FilePath   = string
type Hash       = string
type Url        = string
type NEArray<A> = NEA.NonEmptyArray<A>

// Small helper functions
const base64Decode        = (s: string): string => Buffer.from(s, 'base64').toString()
const stringToHash        = (s: string): Hash => createHash('md5').update(s).digest('hex')
const traverseArrayTE          = A.array.traverse(TE.taskEither)
const traverseNEArrayTE          = NEA.nonEmptyArray.traverse(TE.taskEither)
const traverseNEArrayWithIndexTE = NEA.nonEmptyArray.traverseWithIndex(TE.taskEither)

// -------------------------------------------------------------------------------------------------
// Web article/post content and metadata extraction
// -------------------------------------------------------------------------------------------------

// Specific imports for this cloud function
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
  const pubsub: Topic   = (new PubSub()).topic(config.gcpPubSubTtsTopicName)
  const contentToBuffer = (x: Mercury.ParseResult): Buffer => Buffer.from(JSON.stringify(x))

  // In
  await pipe(
    TE.tryCatch( () => Mercury.parse(url), (): ParseError => 'MercuryParser'),
    TE.chain   ( c  => c.content ? TE.right(c) : TE.left<ParseError>('EmptyBody') ),
    TE.map     ( flow(processMercuryResult, contentToBuffer) ),
    TE.chain   ( b  => TE.tryCatch(() => pubsub.publish(b), (): ParseError => 'PubSub') ),
  )()
    .then(x =>
      pipe(
        x,
        E.fold(
          e => {
            switch(e) {
            case 'MercuryParser': error('Error while trying to parse webpage.')(); break
            case 'EmptyBody'    : error('Error, no body consent returned by parser.')(); break
            case 'PubSub'       : error('Error, failed to send message to TTS function.')(); break
            default             : error('Somehow and error occured that wasn\'t accounted for.')
            }
          },
          () => {}
        )
      )
    )
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

  // In
  const out = Object.assign({}, x)
  out.content = newContent
  return out
}

// -------------------------------------------------------------------------------------------------
// Text to speech conversion
// -------------------------------------------------------------------------------------------------

// Specific imports for this cloud function
import TextToSpeech from '@google-cloud/text-to-speech'
import { SynthesizeSpeechRequest, SynthesizeSpeechResponse } from '@google-cloud/text-to-speech'

const chunkText = require('chunk-text') //eslint-disable-line
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import rmrf from 'rimraf'

// Error type for this cloud function
type TTSError =
  'RmWorkingDir'
  | 'MkWoringDir'
  | 'TTSConversion'
  | 'WriteAudioChuck'
  | 'WriteAudioFile'
  | 'BucketWrite'
  | 'RmWorkingDirEnd'

// Cloud function triggered by PubSub message that receives consent and metadata and creates TTS audio file.
export const textToSpeech = async (m: PubSubMessage): Promise<void> => {
  // Let
  const contentData: Mercury.ParseResult = JSON.parse(base64Decode(m.data))
  const chunkedContent: NEArray<string>  = chunkText(contentData.content, 5000) //5000 chars is the TTS API limit
  const workingDirName: string           = stringToHash(contentData.url)
  const workingDirPath: DirPath          = path.join(tmpdir(), workingDirName)
  const removeWorkingDir                 = (x: TTSError): TE.TaskEither<TTSError, void> =>
    TE.tryCatch( ()  => promisify(rmrf)(workingDirPath), (): TTSError => x )

  // In
  await pipe(
    sequenceT(TE.taskEither)(
      pipe(
        removeWorkingDir('RmWorkingDir'),
        TE.chain( ()  => TE.tryCatch(() => promisify(mkdir)(workingDirPath), (): TTSError => 'MkWoringDir') )
      ),
      traverseNEArrayTE(chunkedContent, getTtsAudio)
    ),
    TE.chain( t   => traverseNEArrayWithIndexTE(snd(t), (i, x) => writeChunkAudioFile(workingDirPath, i, x)) ),
    TE.chain( fps => concatAudioFiles(fps, workingDirPath) ),
    TE.chain( fp  => createGcsObject(fp, contentData) )
  )()
    .then(x =>
      pipe(
        x,
        E.fold(
          e => {
            switch(e) {
            case 'RmWorkingDir'   : error('Error while trying to remove old working directory.')(); break
            case 'MkWoringDir'    : error('Error creating working directory.')(); break
            case 'TTSConversion'  : error('Error during TTS conversion step.')(); break
            case 'WriteAudioChuck': error('Error writing an audio chunk to disk.')(); break
            case 'WriteAudioFile' : error('Error concatinating audio chunk.')(); break
            case 'BucketWrite'    : error('Error writing file to bucket.'); break
            default               : error('Somehow and error occured that wasn\'t accounted for.')
            }
          },
          () => {}
        )
      )
    )
    .then( () => removeWorkingDir('RmWorkingDirEnd')() )
    .then( x  => pipe( x, E.fold( () => error('Error cleaning up working directory')(), () => {} )) )
}

// Helper function that creates creates a TaskEither to convert a string to audio.
const getTtsAudio = (s: string): TE.TaskEither<TTSError, NEArray<SynthesizeSpeechResponse>> => {
  // Let
  const ttsClient = new TextToSpeech.TextToSpeechClient()
  const ttsRequest: SynthesizeSpeechRequest =
    { input      : { text: s }
    , voice      : { languageCode: 'en-US', name: 'en-US-Wavenet-F', ssmlGender: 'FEMALE' }
    , audioConfig: { audioEncoding: 'MP3', effectsProfileId: ['headphone-class-device'] }
    }

  // In
  return TE.tryCatch(() => ttsClient.synthesizeSpeech(ttsRequest), (): TTSError => 'TTSConversion')
}

// Helper function that creates a TaskEither to write an audio chunck to disk
const writeChunkAudioFile = (d: DirPath, i: number, [a]: NEArray<SynthesizeSpeechResponse>): TE.TaskEither<TTSError, FilePath> => {
  // Let
  const fp: FilePath = path.join(d, `${i + 1000}.mp3`)

  // In
  return pipe(
    TE.tryCatch( () => promisify(writeFile)(fp, a.audioContent, 'binary'), (): TTSError => 'WriteAudioChuck' ),
    TE.map     ( () => fp)
  )
}

// Helper function that creates a TaskEither that concatinates audio chunks and writes the file to disk.
const concatAudioFiles = (fps: NEArray<FilePath>, d: DirPath): TE.TaskEither<TTSError, FilePath> => {
  if (fps.length == 1) {
    return TE.taskEither.of(NEA.head(fps))
  }
  else {
    // Let
    const ffmpegCmd = ffmpeg()
    const fp: FilePath = path.join(d, 'audio.mp3')
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
    return TE.tryCatch( () => ffmpegPromise, (): TTSError => 'WriteAudioFile' )
  }
}

// Helper function that creates a TaskEither that writes the audio file to GCS
const createGcsObject = (fp: FilePath, c: Mercury.ParseResult): TE.TaskEither<TTSError, UploadResponse> => {
  // Let
  const bucket = (new Storage()).bucket(config.gcpBucketName)
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
  return TE.tryCatch( () => bucket.upload(fp, objectOptions), (): TTSError => 'BucketWrite' )
}

// -------------------------------------------------------------------------------------------------
// Podcast feed generation
// -------------------------------------------------------------------------------------------------

// Specific imports for this cloud function
import Podcast from 'podcast'

// Specific types for this cloud function
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
  const bucket         = (new Storage()).bucket(config.gcpBucketName)
  const rssFileName    = 'podcast.xml'
  const rssFileOptions = { public: true, contentType: 'application/rss+xml' }
  const feedOptions: Podcast.FeedOptions =
    { title      : config.podTitle
    , description: config.podDescription
    , feedUrl    : 'http://storage.googleapis.com/' + config.gcpBucketName + '/' + rssFileName
    , siteUrl    : config.podSiteUrl
    , author     : config.podAuthor
    , language   : config.podLanguage
    //, itunesType : config.podType
    }

  console.log

  // In
  if (event.name == rssFileName) {
    console.log('False alarm, it was just the RSS feed being updated.')
    return
  }

  await pipe(
    TE.tryCatch( () => bucket.getFiles(), (): PodcastError => 'GetBucketObjects' ),
    TE.chain   ( r  => traverseArrayTE(r[0], f => TE.tryCatch( () => f.getMetadata(), (): PodcastError => 'GetObjectMeta'))),
    TE.map     ( ms => A.array.filter(ms, ([x]: Metadata) => x.contentType == 'audio/mpeg') ),
    TE.map( x => {console.log(x); return x}),
    TE.map     ( ms => ms.map(createRssItem) ),
    TE.map     ( is => (new Podcast(feedOptions, is)).buildXml(true) ),
    TE.chain   ( p  => TE.tryCatch( () => bucket.file(rssFileName).save(p, rssFileOptions), (): PodcastError => 'RSSFileWrite') )
  )()
    .then(x =>
      pipe(
        x,
        E.fold(
          e => {
            switch(e) {
            case 'GetBucketObjects': error('Error retriving objects from bucket.')(); break
            case 'GetObjectMeta'   : error('Error retriving object metadata.')(); break
            case 'RSSFileWrite'    : error('Error writing RSS feed file to bucket.')(); break
            default                : error('Somehow and error occured that wasn\'t accounted for.')
            }
          },
          () => {}
        )
      )
    )
}

// Helper function
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
