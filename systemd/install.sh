#!/bin/sh

# See https://stackoverflow.com/questions/4774054/
SCRIPTPATH="$( cd "$(dirname "$0")" ; pwd -P )"
TARGETPATH=$HOME/.config/systemd/user

mkdir -p $TARGETPATH
for FILE in `ls $SCRIPTPATH/*.service`; do
	TARGETFILE=$TARGETPATH/`basename $FILE`
	ln -s $FILE $TARGETFILE
	echo "Link: $FILE \n  -> $TARGETFILE"
done

systemctl --user daemon-reload
