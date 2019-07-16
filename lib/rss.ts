// Functional programming related
import { pipe } from 'fp-ts/lib/pipeable'
import { error, log } from 'fp-ts/lib/Console'
import { array } from 'fp-ts/lib/Array'
import { fold } from 'fp-ts/lib/Either'
import { TaskEither, chain, map, tryCatch } from 'fp-ts/lib/TaskEither'

// Google APIs
import { Metadata } from '@google-cloud/common'
import { GetFileMetadataResponse, GetFilesResponse, Storage } from '@google-cloud/storage'

// Other npm packages
import Podcast from 'podcast'

// Local imports
import { StorageEvent } from './types'
import { conf, traverseArrayTE } from './util'

// Error type
type RssGenErrorType =
  'GetBucketObjects'
  | 'GetObjectMeta'
  | 'RSSFileWrite'

// Cloud function triggered by bucket update that generate the podcast RSS.
export const generatePodcastRss = async (event: StorageEvent): Promise<void> => {
  // Let
  const bucket         = (new Storage()).bucket(conf.gcp.bucket)
  const rssFileName    = 'podcast.xml'
  const rssFileOptions = { public: true, contentType: 'application/rss+xml' }
  const feedOptions: Podcast.FeedOptions =
    { ...conf.podcast
    , feedUrl: `http://storage.googleapis.com/${conf.gcp.bucket}/${rssFileName}`
    , ttl    : 1
    }

  const getFilesFromBucket = (): TaskEither<RssGenErrorType, GetFilesResponse> =>
    tryCatch( () => bucket.getFiles(), () => 'GetBucketObjects' as RssGenErrorType )
  const getFilesMetadata = ([r]: GetFilesResponse): TaskEither<RssGenErrorType, GetFileMetadataResponse[]> =>
    traverseArrayTE(r, f => tryCatch( () => f.getMetadata(), () => 'GetObjectMeta' as RssGenErrorType))
  const writeFeedToBucket = (f: string): TaskEither<RssGenErrorType, void> =>
    tryCatch( () => bucket.file(rssFileName).save(f, rssFileOptions), () => 'RSSFileWrite' as RssGenErrorType)

  // In
  if (event.name == rssFileName) {
    log('Object that changed in bucket was rss file.')()
    return
  }

  await pipe(
    getFilesFromBucket(),
    chain( getFilesMetadata ),
    map  ( ms => array.filter(ms, ([x]) => x.contentType == 'audio/mpeg') ),
    map  ( ms => ms.map(createRssItem) ),
    map  ( is => (new Podcast(feedOptions, is)).buildXml(true) ),
    chain( writeFeedToBucket )
  )()
    .then(x => pipe( x, fold(
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
