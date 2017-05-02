#!/usr/bin/env node

// Copyright (c) 2017 Ian Warrington

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import * as aws from "aws-sdk";
import * as rx from "rxjs";
import * as argparse from "argparse";

const DEFAULT_HISTORIC_LINES = 20;
const DEFAULT_SAMPLE_INTERVAL_SECONDS = 5;

interface CommandLineArgs {
    numLines?: number
    logGroupName: string
    awsRegion: string
    sampleIntervalSeconds?: number
    logStreamName?: string
}

enum PhaseEnum {
    Historic,
    Live
}

interface StreamRecord {
    message: string
    logStreamName: string
    timestamp: Date
    phase: PhaseEnum
}

interface StreamPair<T> {
    Historic: rx.Observable<T>
    Live: rx.Observable<T>
}

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
let parsedArgs = <CommandLineArgs>parser.parseArgs();

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
},
    (error, data) => {
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
            // It's likely compiling the results for the historic stream will
            // be out-of-order, so sort them before returning the last N rows
            .toArray()
            .flatMap(array => array.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()))
            .takeLast(parsedArgs.numLines)
            // After the historic stream, concat with the live stream. Shouldn't need to sort that
            .concat(liveStream)
            .subscribe(next => {
                console.log(`${PhaseEnum[next.phase]} ${next.timestamp} ${next.logStreamName}: ${next.message}`);
            },
            error => {
                console.error("Error reading from stream");
                console.error(error);
                process.exit(1);
            },
            () => {
                process.exit(0);
            });
    });

let tailStream = function (logGroupName: string, logStreamName): StreamPair<StreamRecord> {
    let historic = new rx.Subject<StreamRecord>();
    let live = new rx.Subject<StreamRecord>();

    let phase = PhaseEnum.Historic; // historic until we get an empty record, then we switch to live
    let stream = historic;

    let tailSample = function (nextToken?: string) {
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
                } else {
                    // Otherwise, it will retry
                    console.error(error);
                }
            } else if (data) {
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