// Functional programming related
import { flow } from 'fp-ts/lib/function'
import { pipe } from 'fp-ts/lib/pipeable'
import { log } from 'fp-ts/lib/Console'
import { chain, left as taskLeft, map, right as taskRight, tryCatch } from 'fp-ts/lib/TaskEither'

// Google APIs
import { PubSub, Topic } from '@google-cloud/pubsub'

// Other npm packages
import * as htmlToText from 'html-to-text'
import Mercury from '@postlight/mercury-parser'

// Local imports
import { conf, base64Decode, handleEither, mkErrConstructor } from './util'
import { PubSubMessage, Url } from './types'

// Error constructors
const MercuryError   = mkErrConstructor('Error while trying to parse webpage.')
const EmptyBodyError = mkErrConstructor('Error, no body content returned by parser.')
const PupSubError    = mkErrConstructor('Error, failed to send message to TTS function.')


// Cloud function triggered by a PubSubMessage that receives a url and returns content and metadata.
export const parseWebpage = async (m: PubSubMessage): Promise<void> => {
  // Let
  const url: Url        = base64Decode(m.data)
  const pubsub: Topic   = (new PubSub()).topic(conf.gcp.ttsPubSubTopic)
  const contentToBuffer = (x: Mercury.ParseResult): Buffer => Buffer.from(JSON.stringify(x))

  // In
  log(`Parsing content of: ${url}`)()
  await pipe(
    tryCatch( () => Mercury.parse(url), MercuryError ),
    chain   ( c  => c.content ? taskRight(c) : taskLeft(EmptyBodyError()) ),
    map     ( flow(processMercuryResult, contentToBuffer) ),
    chain   ( b  => tryCatch(() => pubsub.publish(b), PupSubError ) )
  )().then(handleEither)
}

// Helper function to process content into needed form
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
  return {...x, content: newContent}
}
