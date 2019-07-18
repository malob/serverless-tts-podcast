// This is a template file for the project configuration, fill it out and file rename to config.js 


// Google Cloud Platform (GCP) related user configuration
const gcpUserConfig =
  // Path to the GCP keyfile created using these steps: 
  // https://serverless.com/framework/docs/providers/google/guide/credentials#get-credentials--assign-roles
  { credentialsPath: './keyfile.json'
  // Name of the GCP project
  , project: ''
  // Name of the GCP Storage bucket that will hold the MP3s and RSS feed for the podcast
  , bucket: ''
  // Configuration options for TTS voice (WaveNet voices sound better).
  // A full list of available voices along with audio samples can be found  here:
  // https://cloud.google.com/text-to-speech/docs/voices
  , ttsOptions:
    { voice:
      { languageCode: 'en-US'
      , name        : 'en-US-Wavenet-F'
      , ssmlGender  : 'FEMALE'
      }
    }
  }

// User configuration for podcast feed metadata
const podcastUserConfig =
  { title      : 'My Text-To-Speech Podcast'
  , description: 'My personal podcast of cool articles.'
  , siteUrl    : 'https://yourwebsite.com'
  , author     : 'Your Name'
  , language   : 'en'
  }


// Put together the full config (you shouldn't change anything below unless you know what your doing).
const config =
  { gcp:
    { ...gcpUserConfig
    , bucketUrl        : `http://strorage.googleapis.com/${gcpUserConfig.bucket}`
    , parserPubSubTopic: 'url'
    , ttsPubSubTopic   : 'tts'
    , ttsCharLimit     : 5000 // current limit of the GCP TTS API.
    }
  , podcast:
    { ...podcastUserConfig
    , rssFileName: 'podcast.xml'
    }
  }

module.exports = () => config
