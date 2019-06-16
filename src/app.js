const express = require('express');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const to = require('await-to-js').default;
const request = require('request');

const redis = require("redis");
const redisClient = redis.createClient({host: '127.0.0.1', port: '6379', prefix: 'qns-dist-map-generator'});

const port = process.argv[1] && !isNaN(process.argv[1]) ? process.argv[1] : 3000; //check process args for port else use 3000

const config = require('../config.json');
const app = express();

const writeDir = path.join(__dirname, '../data/distMaps').split('\\').join('/');

app.get('/', async (req, res) => {
    let avhSearchName = req.query.avhSearchName;
    log(`Got query for ${avhSearchName}`);
    if(!avhSearchName) return returnInvalidSearchName(res, req.query.avhSearchName);
    avhSearchName = avhSearchName.replace(/[/\\?%*:|"<>]/g, ''); //Remove illegal characters from file system traversal

    if(!fs.existsSync(writeDir)) await createDir(writeDir); //create write dirtectory if not exists

    const writePath = `${writeDir}/${avhSearchName}.jpg`;

    if(fs.existsSync(writePath)) { //File already exists
        const [,record] = await to(redisGet(avhSearchName)); //get db record for file
        if(record) { //has record
            const timeSinceUpdate = (new Date().getTime() - new Date(record.lastUpdateTime))/1000;
            if(timeSinceUpdate < record.updateInterval) return streamFile(res, writePath, avhSearchName); //Return existing file since it is younger than the update interval
        }
    }

    let [err, dotImage] = await to(Jimp.read(`https://biocache-ws.ala.org.au/ws/webportal/wms/image?q=${avhSearchName}&extents=112,-44,155,-10&format=png&dpi=600&pradiusmm=0.7&popacity=1&pcolour=7DA831&widthmm=60&scale=off&outline=true&outlineColour=0x000000&baselayer=nobase&fileName=MyMap.png`));
    if(err) return returnAVHError(res, err, avhSearchName);

    let [err2, baseImage] = await to(Jimp.read(path.join(__dirname, '../data/basemap.png')));
    if(err2) return returnBaseMapError(res, err2, avhSearchName);

    await compositeImages(dotImage, baseImage, writePath, avhSearchName);

    const [,record] = await to(redisGet(avhSearchName)); //get db record for file
    if(!record) await to(redisSet(avhSearchName, 'updateInterval', getRandomDayInSec()*86400, 'lastUpdateTime', new Date()));
    else await to(redisSet(avhSearchName, 'updateInterval', record.updateInterval, 'lastUpdateTime', new Date()));

    return streamFile(res, writePath, avhSearchName);
});

const streamFile = (res, filePath, avhSearchName) => {
    log(`Streaming file back for ${avhSearchName}`)
    return fs.createReadStream(filePath).pipe(res);
};

const getRandomDayInSec = () => {
    return Math.floor(Math.random() * (7 - 2 + 1)) + 2;
}

const compositeImages = (dotImage, baseImage, writePath, avhSearchName) => {
    return new Promise((resolve) => {
        log(`Compositing images for ${avhSearchName}`);
        baseImage.composite(dotImage, 0, 0, {
            mode: Jimp.BLEND_SOURCE_OVER,
            opacitySource: 0.9,
            opacityDest: 1
        }).quality(65).write(writePath, resolve) //write to cache directory. This will make a fine addition to my collection.
    })
};

const createDir = (dir) => {
    return new Promise((resolve, reject) => {
        fs.mkdir(dir, { recursive: true }, (err) => {
            if (err) return reject(err);
            resolve();
        });
    })
};

const returnInvalidSearchName = (res, avhSearchName) => {
    log(`Invalid search name error for ${avhSearchName}`);
    return res.status(500).json({error: {msg: "Invalid search name", err: null}});
};

const returnAVHError = (res, err, avhSearchName) => {
    log(`Error connecting to AVH error for ${avhSearchName}`);
    return res.status(500).json({error: {msg: "Error connecting to AVH", err}});
};

const returnBaseMapError = (res, err, avhSearchName) => {
    log(`Error getting base map error for ${avhSearchName}`);
    return res.status(500).json({error: {msg: "Error getting base map", err}});
};

const log = (text) => {
    console.log(`${port} | ${text}`);
};

const redisGet = async (avhSearchName) => {
    return new Promise((resolve, reject) => {
        redisClient.hgetall(avhSearchName, (err, object) => {
            if(err) return reject(err);
            return resolve(object);
        })
    })
};

const redisSet = async (...args) => {
    return new Promise((resolve, reject) => {
        redisClient.hmset(...args, (err, res) => {
            if(err) return reject(err);
            return resolve(res);
        })
    })
};

setInterval(() => {
    if(port !== 3000) return;
    log('Checking if re-build required');
    request(`http://api.netlify.com/api/v1/sites/${config.netlifySiteId}/deploys`, (err, res, body) => {
        if(err) return console.error(err);
        const jsonData = JSON.parse(body);
        const lastDeployTime = new Date(jsonData[0].created_at);
        const timeSinceLastDeploy = (new Date().getTime() - lastDeployTime)/1000;
        if(timeSinceLastDeploy > 86400) {
            log('Re-building site');
            request({method: 'POST', url: `http://api.netlify.com/api/v1/sites/${config.netlifySiteId}/builds`, headers: {Authorization: config.netlifyAuthorization}, data: `{"clear_cache":false}`})
        }
    })
},86400*1000);

app.listen(port, () => console.log(`QNS Dist Map Generator listening on port ${port}!`));