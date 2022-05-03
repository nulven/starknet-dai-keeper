import fs from "fs";
import delay from "delay";
import * as starknet from "starknet";
import { ethers, utils } from "ethers";
import { assert } from "ts-essentials";
const { genKeyPair, getStarkKey } = starknet.ec;
import * as dotenv from "dotenv";
dotenv.config();

const MASK_250 = BigInt(2 ** 250 - 1);

function toUint(splitUint: object): bigint {
  const _a = Object.values(splitUint);
  return BigInt(`0x${_a[1].toString(16)}${_a[0].toString(16)}`);
}

export function toBytes32(a: string): string {
  return `0x${BigInt(a).toString(16).padStart(64, "0")}`;
}

export function getSelectorFromName(name: string) {
  return (
    BigInt(utils.keccak256(Buffer.from(name))) % MASK_250
  ).toString();
}

export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  assert(value, `Please provide ${key} in .env file`);

  return value;
}

export async function getL1ContractAt(signer: any, name: string, address: string) {
  console.log(`Using existing contract: ${name} at: ${address}`);
  const compiledContract = JSON.parse(
    fs.readFileSync(`./abis/${name}.json`).toString("ascii")
  );
  const contractFactory = new ethers.ContractFactory(compiledContract.abi, compiledContract.bytecode, signer);
  return contractFactory.attach(address);
}

export async function getL2ContractAt(signer: any, name: string, address: string) {
  console.log(`Using existing contract: ${name} at: ${address}`);
  const compiledContract = JSON.parse(
    fs.readFileSync(`./abis/${name}.json`).toString("ascii")
  );
  const contractFactory = new starknet.ContractFactory(compiledContract, signer);
  return contractFactory.attach(address);
}

function getL1Signer(network: string) {
  let baseUrl;
  const infuraApiKey = getRequiredEnv("INFURA_API_KEY");
  if (network === "MAINNET") {
    baseUrl =  `https://mainnet.infura.io/v3/${infuraApiKey}`;
  } else if (network === "GOERLI") {
    baseUrl =  `https://goerli.infura.io/v3/${infuraApiKey}`;
  } else if (network === "LOCALHOST") {
    baseUrl = "http://localhost:8545";
  }
  const provider = ethers.getDefaultProvider(baseUrl);
  const mnemonic = getRequiredEnv("MNEMONIC");
  return ethers.Wallet.fromMnemonic(mnemonic).connect(provider);
}

function getL2Signer(network: string) {
  let baseUrl;
  if (network === "MAINNET") {
    baseUrl = "https://alpha-mainnet.starknet.io";
  } else if (network === "GOERLI") {
    baseUrl = "https://alpha4.starknet.io";
  } else if (network === "LOCALHOST") {
    baseUrl = "http://localhost:5000";
  }
  const provider = new starknet.Provider({
      baseUrl,
      feederGatewayUrl: 'feeder_gateway',
      gatewayUrl: 'gateway',
  });
  const address = getRequiredEnv("L2_ADDRESS");
  const l2PrivateKey = getRequiredEnv("L2_PRIVATE_KEY");
  const starkKeyPair = starknet.ec.genKeyPair(l2PrivateKey);
  const starkKeyPub = starknet.ec.getStarkKey(starkKeyPair);;
  const compiledArgentAccount = JSON.parse(
    fs.readFileSync("./abis/ArgentAccount.json").toString("ascii")
  );
  return new starknet.Account(provider, address, starkKeyPair);
}

async function flush() {
    const NETWORK = getRequiredEnv("NETWORK").toUpperCase();

    const l1Signer = getL1Signer(NETWORK);
    const l2Signer = getL2Signer(NETWORK);

    const l1WormholeGatewayAddress = getRequiredEnv(`${NETWORK}_L1_DAI_WORMHOLE_GATEWAY_ADDRESS`);
    const l2WormholeGatewayAddress = getRequiredEnv(`${NETWORK}_L2_DAI_WORMHOLE_GATEWAY_ADDRESS`);
    const l1WormholeGateway = await getL1ContractAt(l1Signer, "L1DAIWormholeGateway", l1WormholeGatewayAddress);
    const l2WormholeGateway = await getL2ContractAt(l2Signer, "l2_dai_wormhole_gateway", l2WormholeGatewayAddress);

    const domain = getRequiredEnv("DOMAIN");
    const encodedDomain = `0x0${ethers.utils.formatBytes32String(domain).slice(2, 65)}`;
    const { res: daiToFlushSplit } = await l2WormholeGateway.batched_dai_to_flush(encodedDomain);
    const daiToFlush = toUint(daiToFlushSplit);
    console.log(`DAI to flush: ${daiToFlush}`);

    if (daiToFlush > 0) {
      console.log("Sending `flush` transaction");
      let { code, transaction_hash: txHash } = await l2WormholeGateway.flush(encodedDomain, { maxFee: "0" });

      console.log(`Waiting for transaction ${txHash} to be accepted on L1`);
      while (code !== "ACCEPTED_ON_L1") {
        const res = await l2Signer.getTransactionStatus(txHash);
        code = res.tx_status;
        if (code === "REJECTED") {
          throw Error(`Tx failed: ${res.tx_failure_reason.error_message}`);
        }
        console.log(`Transaction status: ${code}`);
        await delay(1000);
      }

      console.log("Sending `finalizeFlush` transaction");
      await l1WormholeGateway.finalizeFlush(encodedDomain, daiToFlush);
    }
}

flush();
