// Node libraries
//let fs;
//let os;
//let path;
//let crypto;

// Google APIs
import { PubSub, Topic } from '@google-cloud/pubsub'
//let TextToSpeech;
//const { Storage } = require('@google-cloud/storage');


// Other npm packages
//let chunkText;
//let ffmpeg;
//let ffmpegStatic;
//let ffprobeStatic;
//let rimraf;
//let Podcast;

// Config
import * as config from './config.json'


// -------------------------------------------------------------------------------------------------
// Web article/post content and metadata extraction
// -------------------------------------------------------------------------------------------------

import * as htmlToText from 'html-to-text'
import Mercury from '@postlight/mercury-parser' //eslint-disable-line

// Interfaces and types
interface PubSubMessage {
  data: string;
}

type Url = string

// Cloud function that recieves a url and returns text and metadata triggerd by PubSub message
// TODO: Add lazy loading of imports into globals
export const dataFromUrl = async (m: PubSubMessage): Promise<void> => {
  // Let
  const url: string = Buffer.from(m.data, 'base64').toString()
  const pubsub: Topic = (new PubSub()).topic(config.gcpPubSubTtsTopicName)
  // In
  await parseArticle(url)
    .then(processMercuryResult)
    .then(x => pubsub.publish(Buffer.from(JSON.stringify(x))))
}

// Use Mercury Parser to get article consent and metadata
const parseArticle = async (x: Url): Promise<Mercury.ParseResult> => {
  const result: Mercury.ParseResult = await Mercury.parse(x)
  if (!result.content) { Error('Mercury Parser could not find or process the article body.') }
  return result
}

// Mercury API returns article content as HTML, so I use html-to-text to
// to convert the HTML to plain text.
// TODO: Lots of data mutation here, don't like it
const processMercuryResult = async (x: Mercury.ParseResult): Promise<Mercury.ParseResult> => {
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

// Cloud function that receives text and metadata and creates TTS audo file
// triggerd by PubSub message
//exports.textToSpeech = async (data) => {
//  // Lazyly load dependencies
//  fs = require('fs');
//  os = require('os');
//  path = require('path');
//  crypto = require('crypto');

//  TextToSpeech = require('@google-cloud/text-to-speech');

//  chunkText = require('chunk-text');
//  ffmpeg = require('fluent-ffmpeg');
//  ffmpegStatic = require('ffmpeg-static');
//  ffprobeStatic = require('ffprobe-static');
//  rimraf = require('rimraf');

//  // Get text data from PubSub message and chunk text
//  const textData = JSON.parse(Buffer.from(data.data, 'base64').toString());
//  const text = chunkText(textData.content, 5000);

//  // Create working directory and run TTS in parallel
//  try {
//    var temp = await Promise.parallel([
//      mkWorkingDir(crypto.createHash('md5').update(textData.url).digest('hex')),
//      Promise.map(text, getTtsAudio)
//    ]);
//  } catch (err) {
//    console.error('Failed:\n', err);
//    return;
//  }
//  const workingDir = temp[0];
//  const audio = temp[1];

//  // Write audio files to disk
//  const filePaths = await Promise
//    .each(audio, (audioData, index) => {
//      const filePath = path.join(workingDir, `${index + 1000}.mp3`);
//      fs.writeFileSync(filePath, audioData, 'binary');
//    })
//    .then(() => Promise.promisify(fs.readdir)(workingDir))
//    .then(files => { return files.sort(); })
//    .then(files => { return files.map((x) => { return path.join(workingDir, x); }); })
//    .catch(err => {
//      console.error('Failed writing files to disk', err);
//      return Promise.promisify(rimraf)(workingDir);
//    });

//  // Concatenate audio files into a single file
//  const singleFilePath = await concatAudioFiles(filePaths, workingDir);

//  // Send audio file to GCS
//  return await createGcsObject(textData, singleFilePath)
//    .then(() => {
//      console.log('File successfully sent to GCS:\n');
//    })
//    .catch(err => {
//      console.error('Failed to send to GCS:\n', err);
//      return Promise.promisify(rimraf)(workingDir);
//    });
//};

////Create working directory
//async function mkWorkingDir(name) {
//  const workingDir = path.join(os.tmpdir(), name);

//  return await Promise.promisify(rimraf)(workingDir)
//    .then(() => Promise.promisify(fs.mkdir)(workingDir))
//    .then(() => { return workingDir; });
//}

//// Uses Googles Text-To-Speech API to generate audio from text
//async function getTtsAudio(str) {
//  const ttsClient = new TextToSpeech.TextToSpeechClient();
//  const ttsRequest = {
//    input: { text: str },
//    voice: { languageCode: 'en-US', name: 'en-US-Wavenet-F', ssmlGender: 'FEMALE' },
//    audioConfig: { audioEncoding: 'MP3', effectsProfileId: 'headphone-class-device' },
//  };

//  return await new Promise((resolve, reject) => {
//    ttsClient.synthesizeSpeech(ttsRequest, (err, response) => {
//      if (response) { resolve(response.audioContent); }
//      else { reject(Error(err)); }
//    });
//  });
//}

//// Used to concatenate audio files with ffmpeg and returns the path to the concatenated file
//async function concatAudioFiles(filePaths, workingDir) {
//  if (filePaths.length == 1) { return filePaths[0]; }
//  else {
//    var ffmpegCmd = ffmpeg();
//    const singleFilePath = path.join(workingDir, 'audio.mp3');

//    filePaths.forEach((x) => { ffmpegCmd.input(x); });

//    return await new Promise((resolve, reject) => {
//      ffmpegCmd
//        .setFfmpegPath(ffmpegStatic.path)
//        .setFfprobePath(ffprobeStatic.path)
//        .on('error', (err) => { reject(Error(err)); })
//        .on('end', () => { resolve(singleFilePath); })
//        .mergeToFile(singleFilePath, workingDir);
//    });
//  }
//}

//// Used to send concatenated audio file to Google Cloud Storage
//async function createGcsObject(textData, audioPath) {
//  const storage = new Storage();

//  // Hash article URL to to use as Object name
//  const hash = crypto.createHash('md5').update(textData.url).digest('hex');

//  const objectOptions = {
//    destination: hash + '.mp3',
//    public: true,
//    metadata: {
//      contentType: 'audio/mpeg',
//      metadata: {
//        title: textData.title,
//        author: textData.author,
//        excerpt: textData.excerpt,
//        url: textData.url,
//        datePublished: textData.date_published,
//        leadImageUrl: textData.lead_image_url
//      }
//    }
//  };

//  return await storage.bucket(config().gcpBucketName).upload(audioPath, objectOptions);
//}



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
