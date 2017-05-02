# cloudtail

A command line tool to tail Amazon CloudWatch logs

## Usage

First, install the package using npm:

    npm install -g cloudtail

Then, execute on the command line, specifying your region and log group:

    cloudtail --awsRegion ap-southeast-2 /your/log/group/here

The functionality is similar to the Unix `tail -f` command. Initially the latest `-n` lines of log data will be sourced from the log group, after which the live log entries will appear as they are written.

Within your log log group, all log streams' data will be aggreated into a single unified output to the cosole. You can isolate a single log stream using the `--logStreamName` argument.

## License

MIT