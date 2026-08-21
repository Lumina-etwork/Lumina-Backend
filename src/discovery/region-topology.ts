export const regionTopology: Record<string, { peers: string[] }> = {
    "us-east": { peers: ["us-west", "eu-central", "ap-south"] },
    "eu-central": { peers: ["us-east", "ap-south", "us-west"] },
    "us-west": { peers: ["us-east", "eu-central", "ap-south"] },
    "ap-south": { peers: ["eu-central", "us-east", "us-west"] }
};
