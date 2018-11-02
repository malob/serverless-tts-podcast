'use strict';

// Node libraries
let fs;
let os;
let path;
let crypto;

// Google APIs
let PubSub;
let TextToSpeech;
const { Storage } = require('@google-cloud/storage');


// Other npm packages
const Aigle = require('aigle');
global.Promise = Aigle;

let request;
let htmlToText;
let chunkText;
let ffmpeg;
let ffmpegStatic;
let ffprobeStatic;
let rimraf;
let Podcast;

// Config
const config = require('./config');



// Cloud function that recieves a url and returns text and metadata
// triggerd by PubSub message
exports.dataFromUrl = async (data) => {
  // Lazyly load dependencies
  PubSub = require('@google-cloud/pubsub');

  request = require('request-promise-native');
  htmlToText = require('html-to-text');

  // Get url from PubSub message
  const url = Buffer.from(data.data, 'base64').toString();

  // Send request to Mercury and process response
  const reqOptions = {
    url: 'https://mercury.postlight.com/parser?url=' + url,
    json: true,
    headers: { 'x-api-key': config().mercuryApiKey },
    simple: true // response other than 200 is treated as rejected
  };

  try {
    var articleData = await request(reqOptions);
    if (!articleData.content) {
      Error('Mercury Parser could not find or process the article body.');
    }
  } catch (err) {
    console.error('ERROR:', err);
    return;
  }

  // Mercury API returns article content as HTML, so I use html-to-text to
  // to convert the HTML to plain text.
  const htmlToTextOptions = {
    wordwrap: null,
    ignoreHref: true,
    ignoreImage: true,
    preserveNewlines: false,
    uppercaseHeadings: false,
    singleNewLineParagraphs: false
  };

  // Convert content to plain text
  articleData.content = htmlToText.fromString(articleData.content, htmlToTextOptions);

  // Add some of the article metadata to the content
  if (articleData.domain) { articleData.content = 'Published at: ' + articleData.domain + '\n\n' + articleData.content; }
  if (articleData.date_published) {
    const date = new Date(articleData.date_published);
    articleData.content = 'Published on: ' + date.toDateString() + '\n\n' + articleData.content;
  }
  if (articleData.author) { articleData.content = 'By: ' + articleData.author + '\n\n' + articleData.content; }
  if (articleData.title) { articleData.content = articleData.title + '\n\n' + articleData.content; }

  // Send for text-to-speech conversion
  const pubsub = new PubSub();
  const dataBuffer = Buffer.from(JSON.stringify(articleData));

  return await pubsub
    .topic(config().gcpPubSubTtsTopicName)
    .publisher()
    .publish(dataBuffer)
    .then(messageId => {
      console.log('Article sent for TTS conversion. Message ' + messageId);
    })
    .catch(err => {
      console.error('ERROR:', err);
    });
};



// Cloud function that receives text and metadata and creates TTS audo file
// triggerd by PubSub message
exports.textToSpeech = async (data) => {
  // Lazyly load dependencies
  fs = require('fs');
  os = require('os');
  path = require('path');
  crypto = require('crypto');

  TextToSpeech = require('@google-cloud/text-to-speech');

  chunkText = require('chunk-text');
  ffmpeg = require('fluent-ffmpeg');
  ffmpegStatic = require('ffmpeg-static');
  ffprobeStatic = require('ffprobe-static');
  rimraf = require('rimraf');

  // Get text data from PubSub message and chunk text
  const textData = JSON.parse(Buffer.from(data.data, 'base64').toString());
  const text = chunkText(textData.content, 5000);

  // Create working directory and run TTS in parallel
  try {
    var temp = await Promise.parallel([
      mkWorkingDir(crypto.createHash('md5').update(textData.url).digest('hex')),
      Promise.map(text, getTtsAudio)
    ]);
  } catch (err) {
    console.error('Failed:\n', err);
    return;
  }
  const workingDir = temp[0];
  const audio = temp[1];

  // Write audio files to disk
  const filePaths = await Promise
    .each(audio, (audioData, index) => {
      const filePath = path.join(workingDir, `${index + 1000}.mp3`);
      fs.writeFileSync(filePath, audioData, 'binary');
    })
    .then(() => Promise.promisify(fs.readdir)(workingDir))
    .then(files => { return files.sort(); })
    .then(files => { return files.map((x) => { return path.join(workingDir, x); }); })
    .catch(err => {
      console.error('Failed writing files to disk', err);
      return Promise.promisify(rimraf)(workingDir);
    });

  // Concatenate audio files into a single file
  const singleFilePath = await concatAudioFiles(filePaths, workingDir);

  // Send audio file to GCS
  return await createGcsObject(textData, singleFilePath)
    .then(() => {
      console.log('File successfully sent to GCS:\n');
    })
    .catch(err => {
      console.error('Failed to send to GCS:\n', err);
      return Promise.promisify(rimraf)(workingDir);
    });
};

//Create working directory
async function mkWorkingDir(name) {
  const workingDir = path.join(os.tmpdir(), name);

  return await Promise.promisify(rimraf)(workingDir)
    .then(() => Promise.promisify(fs.mkdir)(workingDir))
    .then(() => { return workingDir; });
}

// Uses Googles Text-To-Speech API to generate audio from text
async function getTtsAudio(str) {
  const ttsClient = new TextToSpeech.TextToSpeechClient();
  const ttsRequest = {
    input: { text: str },
    voice: { languageCode: 'en-US', name: 'en-US-Wavenet-F', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'MP3', effectsProfileId: 'headphone-class-device' },
  };

  return await new Promise((resolve, reject) => {
    ttsClient.synthesizeSpeech(ttsRequest, (err, response) => {
      if (response) { resolve(response.audioContent); }
      else { reject(Error(err)); }
    });
  });
}

// Used to concatenate audio files with ffmpeg and returns the path to the concatenated file
async function concatAudioFiles(filePaths, workingDir) {
  if (filePaths.length == 1) { return filePaths[0]; }
  else {
    var ffmpegCmd = ffmpeg();
    const singleFilePath = path.join(workingDir, 'audio.mp3');

    filePaths.forEach((x) => { ffmpegCmd.input(x); });

    return await new Promise((resolve, reject) => {
      ffmpegCmd
        .setFfmpegPath(ffmpegStatic.path)
        .setFfprobePath(ffprobeStatic.path)
        .on('error', (err) => { reject(Error(err)); })
        .on('end', () => { resolve(singleFilePath); })
        .mergeToFile(singleFilePath, workingDir);
    });
  }
}

// Used to send concatenated audio file to Google Cloud Storage
async function createGcsObject(textData, audioPath) {
  const storage = new Storage();

  // Hash article URL to to use as Object name
  const hash = crypto.createHash('md5').update(textData.url).digest('hex');

  const objectOptions = {
    destination: hash + '.mp3',
    public: true,
    metadata: {
      contentType: 'audio/mpeg',
      metadata: {
        title: textData.title,
        author: textData.author,
        excerpt: textData.excerpt,
        url: textData.url,
        datePublished: textData.date_published,
        leadImageUrl: textData.lead_image_url
      }
    }
  };

  return await storage.bucket(config().gcpBucketName).upload(audioPath, objectOptions);
}



// Cloud function to generate RSS feed for podcast
// triggered by an update to bucket
exports.generatePodcastRss = async (data) => {
  // Lazyly load required dependencies
  Podcast = require('podcast');

  // Check if file changed is podcast rss file
  const rssFileName = 'podcast.xml';
  if (data.name == rssFileName) {
    console.log('False alarm, it was just the RSS feed being updated.');
    return;
  }

  // Generate podcast feed object
  const feed = new Podcast({
    title: config().podTitle,
    description: config().podDescription,
    feed_url: 'http://storage.googleapis.com/' + config().gcpBucketName + '/' + rssFileName,
    site_url: config().podSiteUrl,
    author: config().podAuthor,
    language: config().podLanguage,
    itunesType: config().podType
  });

  const storage = new Storage();
  const bucket = storage.bucket(config().gcpBucketName);

  // Get all files from bucket
  return await bucket.getFiles()
    // Get metadata for all files
    .map(results => { return results[0].getMetadata(); })
    // Filter for MP3 files only
    .then(results => { return Promise.filter(results[0], {contentType: 'audio/mpeg'}); })
    // Create RSS item object for each MP3 file
    .map(metadata => {
      return {
        title: metadata.metadata.title,
        description: 'Excerpt: ' + metadata.metadata.excerpt,
        url: metadata.metadata.url,
        author: metadata.metadata.author,
        enclosure: {
          url: 'http://storage.googleapis.com/' + metadata.bucket + '/' + metadata.name,
          size: metadata.size
        },
        date: metadata.timeCreated,
        itunesImage: metadata.metadata.leadImageUrl
      };
    })
    // Add each RSS item object to RSS feed
    .each(rssItem => { feed.addItem(rssItem); })
    // Write RSS feed to bucket
    .then(() => {
      bucket.file(rssFileName).save(feed.buildXml('  '), { public: true, contentType: 'application/rss+xml' });
      console.log('Podcast RSS regenerated.');
    })
    .catch( err => { console.error(err); });
};
