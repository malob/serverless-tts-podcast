// Functional programming related
import { pipe } from 'fp-ts/lib/pipeable'
import { log } from 'fp-ts/lib/Console'
import { array } from 'fp-ts/lib/Array'
import { TaskEither, chain, map, tryCatch } from 'fp-ts/lib/TaskEither'

// Google APIs
import { Metadata } from '@google-cloud/common'
import { GetFileMetadataResponse, GetFilesResponse, Storage } from '@google-cloud/storage'

// Other npm packages
import Podcast from 'podcast'

// Local imports
import { Err, StorageEvent } from './types'
import { conf, handleEither, mkErrConstructor, traverseArrayTE } from './util'

// Error constructors
const getBucketObjectsError = mkErrConstructor('Error retrieving objects from bucket.')
const getObjectMetaError    = mkErrConstructor('Error retrieving object metadata.')
const rssFileWriteError     = mkErrConstructor('Error writing RSS feed file to bucket.')

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

  const getFilesFromBucket = (): TaskEither<Err, GetFilesResponse> =>
    tryCatch( () => bucket.getFiles(), getBucketObjectsError )
  const getFilesMetadata = ([r]: GetFilesResponse): TaskEither<Err, GetFileMetadataResponse[]> =>
    traverseArrayTE( r, f => tryCatch( () => f.getMetadata(), getObjectMetaError) )
  const writeFeedToBucket = (f: string): TaskEither<Err, void> =>
    tryCatch( () => bucket.file(rssFileName).save(f, rssFileOptions), rssFileWriteError )

  // In
  if (event.name == rssFileName) {
    log('Object that changed in bucket was rss file.')()
    return
  }
  else {
    await pipe(
      getFilesFromBucket(),
      chain( getFilesMetadata ),
      map  ( ms => array.filter(ms, ([x]) => x.contentType == 'audio/mpeg') ),
      map  ( ms => ms.map(createRssItem) ),
      map  ( is => (new Podcast(feedOptions, is)).buildXml(true) ),
      chain( writeFeedToBucket )
    )().then(handleEither)
  }
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
