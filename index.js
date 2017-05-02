#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const aws = require("aws-sdk");
const rx = require("rxjs");
const argparse = require("argparse");
const DEFAULT_HISTORIC_LINES = 20;
const DEFAULT_SAMPLE_INTERVAL_SECONDS = 5;
var PhaseEnum;
(function (PhaseEnum) {
    PhaseEnum[PhaseEnum["Historic"] = 0] = "Historic";
    PhaseEnum[PhaseEnum["Live"] = 1] = "Live";
})(PhaseEnum || (PhaseEnum = {}));
let parser = new argparse.ArgumentParser({
    description: "This is the description for the parser app",
});
parser.addArgument(['-n', '--numLines'], {
    help: "Initial lines of historic data to tail",
    type: 'int',
    defaultValue: DEFAULT_HISTORIC_LINES
});
parser.addArgument(['logGroupName'], {
    help: 'Log group name to tail'
});
parser.addArgument(['--awsRegion'], {
    help: 'AWS region',
    required: true
});
parser.addArgument(['--sampleIntervalSeconds'], {
    help: "Stream sample interval, in seconds",
    type: 'int',
    defaultValue: DEFAULT_SAMPLE_INTERVAL_SECONDS
});
parser.addArgument(['--logStreamName'], {
    help: "Specific stream to tail within the log group",
    required: false
});
let parsedArgs = parser.parseArgs();
// From: http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-credentials-node.html
// Here are the ways you can supply your credentials in order of recommendation:
// * Loaded from AWS Identity and Access Management (IAM) roles for Amazon EC2 (if running on Amazon EC2)
// * Loaded from the shared credentials file (~/.aws/credentials)
// * Loaded from environment variables
// * Loaded from a JSON file on disk
// From: http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/configuring-the-jssdk.html
// The SDK for JavaScript doesn't select a region by default. To set the region, update the AWS.Config global configuration object
aws.config.update({
    region: parsedArgs.awsRegion
});
var cw = new aws.CloudWatchLogs();
cw.describeLogStreams({
    logGroupName: parsedArgs.logGroupName
}, (error, data) => {
    if (error) {
        console.error("Error describing log streams");
        console.error(error);
        process.exit(1);
    }
    var logStreams = data.logStreams;
    if (parsedArgs.logStreamName) {
        logStreams = logStreams.filter(s => s.logStreamName == parsedArgs.logStreamName);
    }
    let streamPairs = logStreams.map((value, index) => {
        return tailStream(parsedArgs.logGroupName, value.logStreamName);
    });
    let historicStream = rx.Observable.from(streamPairs).flatMap(o => o.Historic);
    let liveStream = rx.Observable.from(streamPairs).flatMap(o => o.Live);
    let firehose = historicStream
        .toArray()
        .flatMap(array => array.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()))
        .takeLast(parsedArgs.numLines)
        .concat(liveStream)
        .subscribe(next => {
        console.log(`${PhaseEnum[next.phase]} ${next.timestamp} ${next.logStreamName}: ${next.message}`);
    }, error => {
        console.error("Error reading from stream");
        console.error(error);
        process.exit(1);
    }, () => {
        process.exit(0);
    });
});
let tailStream = function (logGroupName, logStreamName) {
    let historic = new rx.Subject();
    let live = new rx.Subject();
    let phase = PhaseEnum.Historic; // historic until we get an empty record, then we switch to live
    let stream = historic;
    let tailSample = function (nextToken) {
        let nextForwardToken = nextToken;
        cw.getLogEvents({
            logGroupName: logGroupName,
            logStreamName: logStreamName,
            nextToken: nextToken
        }, (error, data) => {
            if (error) {
                if (!error.retryable) {
                    // Terminal error with the stream. We're done here
                    stream.error(error);
                    historic.complete();
                    live.complete();
                    return;
                }
                else {
                    // Otherwise, it will retry
                    console.error(error);
                }
            }
            else if (data) {
                if (phase == PhaseEnum.Historic && data.events.length == 0) {
                    // Switch to live mode
                    phase = PhaseEnum.Live;
                    historic.complete();
                    stream = live;
                }
                for (let d of data.events) {
                    let parsed_date = new Date(d.timestamp);
                    stream.next({
                        logStreamName: logStreamName,
                        message: d.message,
                        phase: phase,
                        timestamp: parsed_date
                    });
                }
                nextForwardToken = data.nextForwardToken;
            }
            setTimeout(() => { tailSample(nextForwardToken); }, parsedArgs.sampleIntervalSeconds * 1000);
        });
    };
    tailSample();
    return {
        Historic: historic,
        Live: live
    };
};
//# sourceMappingURL=index.js.map