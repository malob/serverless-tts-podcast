// var url = btoa(window.location.href);
// var xhr = new XMLHttpRequest();
// xhr.open('POST', 'https://pubsub.googleapis.com/v1/projects/${conf.gcp.project}/topics/${conf.gcp.parserPubSubTopic}:publish?key=---YOUR-PUBSUB-API-KEY---', true);
// xhr.setRequestHeader('Content-Type', 'application/json');
// xhr.send('{ "messages": [{ "data": "' + url + '" }] }');

const chalk = require('chalk');
const conf = require('../config')();

// Generated from the code commented out at the top of the file using:
// https://mrcoles.com/bookmarklet/
const bookmarklet = `javascript:(function()%7Bvar%20url%20%3D%20btoa(window.location.href)%3Bvar%20xhr%20%3D%20new%20XMLHttpRequest()%3Bxhr.open('POST'%2C%20'https%3A%2F%2Fpubsub.googleapis.com%2Fv1%2Fprojects%2F${conf.gcp.project}%2Ftopics%2F${conf.gcp.parserPubSubTopic}%3Apublish%3Fkey%3D---YOUR-PUBSUB-API-KEY---'%2C%20true)%3Bxhr.setRequestHeader('Content-Type'%2C%20'application%2Fjson')%3Bxhr.send('%7B%20%22messages%22%3A%20%5B%7B%20%22data%22%3A%20%22'%20%2B%20url%20%2B%20'%22%20%7D%5D%20%7D')%7D)()`

class TtsPodcastInfo {
 constructor() {
    this.hooks = {
      'info:info': this.displayInfo,
    };
  }

  displayInfo() {
    console.log(chalk.green.underline('Bookmarklet'));
    console.log(`${bookmarklet}\n`);


    console.log(chalk.green.underline('Podcast URL'));
    console.log(`${conf.gcp.bucketUrl}/${conf.podcast.rssFileName}`);
  }
}

module.exports = TtsPodcastInfo;
