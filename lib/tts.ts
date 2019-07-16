// Node imports
import { mkdir, writeFile } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'

// Functional programming related
import { pipe } from 'fp-ts/lib/pipeable'
import { sequenceT } from 'fp-ts/lib/Apply'
import { error } from 'fp-ts/lib/Console'
import { fold } from 'fp-ts/lib/Either'
import { TaskEither, chain, map, taskEither, tryCatch } from 'fp-ts/lib/TaskEither'
import { snd } from 'fp-ts/lib/Tuple'

// Google APIs
import { Storage, UploadOptions, UploadResponse} from '@google-cloud/storage'
import TextToSpeech from '@google-cloud/text-to-speech'
import { SynthesizeSpeechRequest, SynthesizeSpeechResponse as TtsResponse } from '@google-cloud/text-to-speech'

// Other npm packages
import chunkText from 'chunk-text'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import Mercury from '@postlight/mercury-parser'
import rmrf from 'rimraf'

// Local imports
import { DirPath, FilePath, PubSubMessage } from './types'
import { conf, base64Decode, stringToHash, traverseArrayTE, traverseArrayWithIndexTE } from './util'

// Error type
type TtsErrorType =
  'RmWorkingDir'
  | 'MkWoringDir'
  | 'TTSConversion'
  | 'WriteAudioChuck'
  | 'ConcatAudioChunks'
  | 'BucketWrite'

// Cloud function triggered by PubSub message that receives content and metadata and creates TTS audio file.
export const textToSpeech = async (m: PubSubMessage): Promise<void> => {
  // Let
  const contentData: Mercury.ParseResult = JSON.parse(base64Decode(m.data))
  const chunkedContent: string[]         = chunkText(contentData.content as string, conf.gcp.ttsCharLimit)
  const workingDirName: string           = stringToHash(contentData.url)
  const workingDirPath: DirPath          = path.join(tmpdir(), workingDirName)

  const removeWorkingDir = (): TaskEither<TtsErrorType, void> =>
    tryCatch( () => promisify(rmrf)(workingDirPath), () => 'RmWorkingDir' as TtsErrorType)
  const createWorkingDir = (): TaskEither<TtsErrorType, void> =>
    tryCatch( () => promisify(mkdir)(workingDirPath), () => 'MkWoringDir' as TtsErrorType )
  const writeAudioChunks =
    (xs: TtsResponse[]): TaskEither<TtsErrorType, FilePath[]> =>
      traverseArrayWithIndexTE(xs, (i, x) => writeAudioChunk(workingDirPath, i, x))

  // In
  await pipe(
    sequenceT(taskEither)(
      pipe           ( removeWorkingDir(), chain(() => createWorkingDir()) ),
      traverseArrayTE( chunkedContent, getTtsAudio )
    ),
    chain( t   => writeAudioChunks(snd(t)) ),
    chain( fps => concatAudioChunks(fps, workingDirPath) ),
    chain( fp  => createGcsObject(fp, contentData) )
  )()
    .then(x => pipe( x, fold(
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
    .then( x  => pipe( x, fold( () => error('Error cleaning up working directory')(), () => {} )) )
}

// Helper function that creates a TaskEither to convert a string to audio.
const getTtsAudio = (s: string): TaskEither<TtsErrorType, TtsResponse> => {
  // Let
  const ttsClient = new TextToSpeech.TextToSpeechClient()
  const ttsRequest: SynthesizeSpeechRequest =
    { input      : { text: s }
    , voice      : conf.gcp.ttsOptions.voice
    , audioConfig: { audioEncoding: 'MP3', effectsProfileId: ['headphone-class-device'] }
    }

  // In
  return pipe(
    tryCatch( () => ttsClient.synthesizeSpeech(ttsRequest), () => 'TTSConversion' as TtsErrorType ),
    map     ( ([x]) => x )
  )
}

// Helper function that creates a TaskEither to write an audio chunck to disk
const writeAudioChunk = (d: DirPath, i: number, a: TtsResponse): TaskEither<TtsErrorType, FilePath> => {
  // Let
  const fp: FilePath = path.join(d, `${i}.mp3`)

  // In
  return pipe(
    tryCatch( () => promisify(writeFile)(fp, a.audioContent, 'binary'), () => 'WriteAudioChuck' as TtsErrorType ),
    map     ( () => fp)
  )
}

// Helper function that creates a TaskEither that concatinates audio chunks and writes the file to disk.
const concatAudioChunks = (fps: FilePath[], d: DirPath): TaskEither<TtsErrorType, FilePath> => {
  if (fps.length == 1) {
    return taskEither.of(fps[0])
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
    return tryCatch( () => ffmpegPromise, () => 'ConcatAudioChunks' as TtsErrorType )
  }
}

// Helper function that creates a TaskEither that writes the audio file to GCS
const createGcsObject = (fp: FilePath, c: Mercury.ParseResult): TaskEither<TtsErrorType, UploadResponse> => {
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
  return tryCatch( () => bucket.upload(fp, objectOptions), () => 'BucketWrite' as TtsErrorType )
}
