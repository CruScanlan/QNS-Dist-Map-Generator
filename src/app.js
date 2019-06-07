const express = require('express');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const to = require('await-to-js').default;
const request = require('request');

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync(path.join(__dirname, '../data/db.json'));

const config = require('../config.json');
const db = low(adapter);
const app = express();

const writeDir = path.join(__dirname, '../data/distMaps').split('\\').join('/');

db.defaults({
    avhSearchNames: []
}).write();

app.get('/', async (req, res) => {
    const avhSearchName = req.query.avhSearchName.replace(/[/\\?%*:|"<>]/g, ''); //Remove illegal characters from file system traversal
    if(!avhSearchName) return returnInvalidSearchName(res);

    if(!fs.existsSync(writeDir)) await createDir(writeDir); //create write dirtectory if not exists

    const writePath = `${writeDir}/${avhSearchName}.jpg`;

    if(fs.existsSync(writePath)) { //File already exists
        const record = db.get('avhSearchNames').find({avhSearchName}).value(); //get db record for file
        if(record) { //has record
            const timeSinceUpdate = (new Date().getTime() - new Date(record.lastUpdateTime))/1000;
            if(timeSinceUpdate < record.updateInterval) return streamFile(res, writePath); //Return existing file since it is younger than the update interval
        }
    }

    let [err, dotImage] = await to(Jimp.read(`https://biocache-ws.ala.org.au/ws/webportal/wms/image?q=${avhSearchName}&extents=112,-44,155,-10&format=png&dpi=600&pradiusmm=0.7&popacity=1&pcolour=7DA831&widthmm=60&scale=off&outline=true&outlineColour=0x000000&baselayer=nobase&fileName=MyMap.png`));
    if(err) return returnAVHError(res, err);

    let [err2, baseImage] = await to(Jimp.read('./data/basemap.png'));
    if(err2) return returnBaseMapError(res, err2);

    await compositeImages(dotImage, baseImage, writePath);

    const record = db.get('avhSearchNames').find({avhSearchName}).value(); //get db record for file
    if(!record) db.get('avhSearchNames').push({avhSearchName, updateInterval: getRandomDayInSec()*86400, lastUpdateTime: new Date()}).write();
    else db.get('avhSearchNames').filter({avhSearchName}).assign({lastUpdateTime: new Date()}).write();

    return streamFile(res, writePath);
});

const streamFile = (res, filePath) => {
    return fs.createReadStream(filePath).pipe(res);
};

const getRandomDayInSec = () => {
    return Math.floor(Math.random() * (7 - 2 + 1)) + 2;
}

const compositeImages = (dotImage, baseImage, writePath) => {
    return new Promise((resolve) => {
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

const returnInvalidSearchName = (res) => {
    return res.status(500).json({error: {msg: "Invalid search name", err: null}});
};

const returnAVHError = (res, err) => {
    return res.status(500).json({error: {msg: "Error connecting to AVH", err}});
};

const returnBaseMapError = (res, err) => {
    return res.status(500).json({error: {msg: "Error getting base map", err}});
}

setInterval(() => {
    request(`http://api.netlify.com/api/v1/sites/${config.netlifySiteId}/deploys`, (err, res, body) => {
        if(err) return console.error(err);
        const jsonData = JSON.parse(body);
        const lastDeployTime = new Date(jsonData[0].created_at);
        const timeSinceLastDeploy = (new Date().getTime() - lastDeployTime)/1000;
        if(timeSinceLastDeploy > 86400) {
            request({method: 'POST', url: `http://api.netlify.com/api/v1/sites/${config.netlifySiteId}/builds`, headers: {Authorization: config.netlifyAuthorization}, data: `{"clear_cache":false}`})
        }
    })
},86400*1000)

app.listen(3000, () => console.log(`Example app listening on port 3000!`));