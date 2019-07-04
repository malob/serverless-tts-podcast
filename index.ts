// Node imports
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Google APIs used throught
import { PubSub, Topic } from '@google-cloud/pubsub'
import { Storage, UploadOptions, UploadResponse } from '@google-cloud/storage'

// Functional programming tools
import { pipe } from 'fp-ts/lib/pipeable'
import { flow } from 'fp-ts/lib/function'
import { array } from 'fp-ts/lib/Array'
import { error } from 'fp-ts/lib/Console'
import * as E from 'fp-ts/lib/Either'
import * as TE from 'fp-ts/lib/TaskEither'

// Other imports used throught
import Mercury from '@postlight/mercury-parser'
import * as config from './config.json'

// Interfaces used throught
interface PubSubMessage {
  data: string;
}

// Small helper functions
const base64ToString = (s: string): string => Buffer.from(s, 'base64').toString()
const stringToHash   = (s: string): string => crypto.createHash('md5').update(s).digest('hex')

// -------------------------------------------------------------------------------------------------
// Web article/post content and metadata extraction
// -------------------------------------------------------------------------------------------------

import * as htmlToText from 'html-to-text'

// Cloud function that recieves a url and returns text and metadata triggerd by PubSub message
export const parseWebpage = async (m: PubSubMessage): Promise<void> => {
  // Let
  const url: string     = base64ToString(m.data)
  const pubsub: Topic   = (new PubSub()).topic(config.gcpPubSubTtsTopicName)
  const contentToBuffer = (x: Mercury.ParseResult): Buffer => Buffer.from(JSON.stringify(x))
  // In
  await pipe(
    TE.tryCatch( () => Mercury.parse(url), e => e ),
    TE.chain   ( c  => c.content ? TE.right(c) : TE.left('Parser failed to find/process content.') ),
    TE.map     ( flow(processMercuryResult, contentToBuffer) ), //eslint-disable-line
    TE.chain   ( b  => TE.tryCatch(() => pubsub.publish(b), e => e) ),
  )().then(
    x => pipe(
      x,
      E.fold(e => error(e)(), () => {})
    )
  )
}

// Helper function to prcoess consent into needed form
const processMercuryResult = (x: Mercury.ParseResult): Mercury.ParseResult => {
  //Let
  const htmlToTextOptions: HtmlToTextOptions =
    { wordwrap               : null
    , ignoreHref             : true
    , ignoreImage            : true
    , preserveNewlines       : false
    , uppercaseHeadings      : false
    , singleNewLineParagraphs: false
    }
  const date: Date = x.date_published ? new Date(x.date_published) : new Date()

  // In
  x.content =
    (x.title          ? `${x.title}\n\n`                           : '') +
    (x.author         ? `By: ${x.author}\n\n`                      : '') +
    (x.date_published ? `Published on: ${date.toDateString()}\n\n` : '') +
    (x.domain         ? `Published at: ${x.domain}\n\n`            : '') +
    htmlToText.fromString(x.content as string, htmlToTextOptions)
  return x
}

// -------------------------------------------------------------------------------------------------
// Text to speech conversion
// -------------------------------------------------------------------------------------------------

import TextToSpeech from '@google-cloud/text-to-speech'
import { SynthesizeSpeechRequest, SynthesizeSpeechResponse } from '@google-cloud/text-to-speech'

const chunkText = require('chunk-text') //eslint-disable-line
import rimraf from 'rimraf'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

// Cloud function that receives text and metadata and creates TTS audo file triggerd by PubSub message
exports.textToSpeech = async (m: PubSubMessage): Promise<void> => {
  // Let
  const contentData: Mercury.ParseResult = JSON.parse(base64ToString(m.data))
  const chunkedContent: string[]         = chunkText(contentData.content, 5000) //5000 chars is the TTS API limit
  const workingDirName: string           = stringToHash(contentData.url)
  const workingDirPath: string           = path.join(os.tmpdir(), workingDirName)

  // In
  await pipe(
    TE.taskify(rimraf)(workingDirPath),
    TE.chain  ( ()  => TE.taskify(fs.mkdir)(workingDirPath) ),
    TE.chain  ( ()  => array.traverse(TE.taskEither)(chunkedContent, getTtsAudio) ),
    TE.chain  ( as  => array.traverseWithIndex(TE.taskEither)(as, (i, x) => writeChunckAudioFile(workingDirPath, i, x)) ),
    TE.chain  ( fps => concatAudioFiles(fps, workingDirPath) ),
    TE.chain  ( fp  => createGcsObject(fp, contentData) )
  )().then(x => console.log(x))
}

const getTtsAudio = (s: string): TE.TaskEither<any, [SynthesizeSpeechResponse]> => {
  // Let
  const ttsClient = new TextToSpeech.TextToSpeechClient()
  const ttsRequest: SynthesizeSpeechRequest =
    { input      : { text: s }
    , voice      : { languageCode: 'en-US', name: 'en-US-Wavenet-F', ssmlGender: 'FEMALE' }
    , audioConfig: { audioEncoding: 'MP3', effectsProfileId: ['headphone-class-device'] }
    }
  // In
  return TE.tryCatch(() => ttsClient.synthesizeSpeech(ttsRequest), e => e)
}

const writeChunckAudioFile = (p: string, i: number, a: [SynthesizeSpeechResponse]): TE.TaskEither<NodeJS.ErrnoException, string> => {
  // Let
  const filePath = path.join(p, `${i + 1000}.mp3`)
  // In
  return pipe(
    TE.taskify<string, Buffer, string, NodeJS.ErrnoException, void>(fs.writeFile)(filePath, a[0].audioContent, 'binary'),
    TE.map( () => filePath)
  )
}

// Used to concatenate audio files with ffmpeg and returns the path to the concatenated file
const concatAudioFiles = (filePaths: string[], workingDir: string): TE.TaskEither<unknown, string> => {
  if (filePaths.length == 1) { return TE.taskEither.of(filePaths[0]) }
  else {
    // Let
    const ffmpegCmd = ffmpeg()
    const singleFilePath = path.join(workingDir, 'audio.mp3')
    filePaths.forEach(x => ffmpegCmd.input(x))
    const ffmpegPromise = new Promise<string>((resolve, reject) => {
      ffmpegCmd
        .setFfmpegPath(ffmpegStatic.path)
        .setFfprobePath(ffprobeStatic.path)
        .on('error', err => reject(Error(err)))
        .on('end'  , ()  => resolve(singleFilePath))
        .mergeToFile(singleFilePath);
    });

    // In
    return TE.tryCatch(() => ffmpegPromise, (e: unknown) => e)

  }
}

// Used to send concatenated audio file to Google Cloud Storage
const createGcsObject = (fp: string, c: Mercury.ParseResult): TE.TaskEither<unknown, UploadResponse> => {
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
  return TE.tryCatch( () => bucket.upload(fp, objectOptions), e => e)
}

// -------------------------------------------------------------------------------------------------
// Podcast feed generation
// -------------------------------------------------------------------------------------------------


//// Cloud function to generate RSS feed for podcast
//// triggered by an update to bucket
//exports.generatePodcastRss = async (data) => {
//  // Lazyly load required dependencies
//  Podcast = require('podcast');

//  // Check if file changed is podcast rss file
//  const rssFileName = 'podcast.xml';
//  if (data.name == rssFileName) {
//    console.log('False alarm, it was just the RSS feed being updated.');
//    return;
//  }

//  // Generate podcast feed object
//  const feed = new Podcast({
//    title: config().podTitle,
//    description: config().podDescription,
//    feed_url: 'http://storage.googleapis.com/' + config().gcpBucketName + '/' + rssFileName,
//    site_url: config().podSiteUrl,
//    author: config().podAuthor,
//    language: config().podLanguage,
//    itunesType: config().podType
//  });

//  const storage = new Storage();
//  const bucket = storage.bucket(config().gcpBucketName);

//  // Get all files from bucket
//  return await bucket.getFiles()
//    // Get metadata for all files
//    .map(results => { return results[0].getMetadata(); })
//    // Filter for MP3 files only
//    .then(results => { return Promise.filter(results[0], {contentType: 'audio/mpeg'}); })
//    // Create RSS item object for each MP3 file
//    .map(metadata => {
//      return {
//        title: metadata.metadata.title,
//        description: 'Excerpt: ' + metadata.metadata.excerpt,
//        url: metadata.metadata.url,
//        author: metadata.metadata.author,
//        enclosure: {
//          url: 'http://storage.googleapis.com/' + metadata.bucket + '/' + metadata.name,
//          size: metadata.size
//        },
//        date: metadata.timeCreated,
//        itunesImage: metadata.metadata.leadImageUrl
//      };
//    })
//    // Add each RSS item object to RSS feed
//    .each(rssItem => { feed.addItem(rssItem); })
//    // Write RSS feed to bucket
//    .then(() => {
//      bucket.file(rssFileName).save(feed.buildXml('  '), { public: true, contentType: 'application/rss+xml' });
//      console.log('Podcast RSS regenerated.');
//    })
//    .catch( err => { console.error(err); });
//};
