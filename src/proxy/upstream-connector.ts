import * as net from 'net';

export class UpstreamConnector {
    public connect(host: string, port: number, isKeepAlive: boolean): net.Socket {
        const socket = new net.Socket();
        
        socket.connect({ host, port }, () => {
            if (!isKeepAlive) {
                socket.setNoDelay(true);
                socket.once('end', () => {
                    socket.destroy(new Error('eager-close'));
                });
            }
        });

        return socket;
    }
}
