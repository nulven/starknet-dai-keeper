import axios from "axios";
import { utils } from "ethers";
import { StarknetContract } from "@shardlabs/starknet-hardhat-plugin/dist/types";
import { ec, hash } from "starknet";
import { assert } from "ts-essentials";
const { genKeyPair, getKeyPair, getStarkKey, sign, verify } = ec;
const { hashMessage } = hash;
import type { KeyPair, Signature } from "starknet";
import { task } from "hardhat/config";
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

export class L2Signer {
  caller: StarknetContract;
  privateKey;
  keyPair: KeyPair;
  publicKey;

  constructor(caller: StarknetContract, privateKey: string) {
    this.caller = caller;
    this.privateKey = privateKey;
    this.keyPair = getKeyPair(this.privateKey);
    this.publicKey = getStarkKey(this.keyPair);
  }

  sign(msgHash: string): Signature {
    return sign(this.keyPair, msgHash);
  }

  verify(msgHash: string, sig: Signature): boolean {
    return verify(this.keyPair, msgHash, sig);
  }

  async sendTransaction(
    contract: StarknetContract,
    selectorName: string,
    calldata: any[] | any,
    nonce: number = 0
  ) {
    if (nonce === 0) {
      const executionInfo = await this.caller.call("get_nonce");
      nonce = executionInfo.res;
    }

    const selector = getSelectorFromName(selectorName);
    const contractAddress = BigInt(contract.address).toString();
    const _calldata = flatten(calldata);
    const msgHash = hashMessage(
      this.caller.address,
      contract.address,
      selector,
      _calldata,
      nonce.toString()
    );

    const sig = this.sign(msgHash);
    // const verified = this.verify(msgHash, sig);

    return this.caller.invoke(
      "__execute__",
      {
        call_array: [
          {
            to: contractAddress,
            selector,
            data_offset: 0,
            data_len: _calldata.length,
          },
        ],
        calldata: _calldata,
        nonce,
      },
      {
        signature: [sig.r, sig.s],
      }
    );
  }
}

export function getSelectorFromName(name: string) {
  return (
    BigInt(utils.keccak256(Buffer.from(name))) % MASK_250
  ).toString();
}

function flatten(calldata: any): any[] {
  const res: any = [];
  Object.values(calldata).forEach((data: any) => {
    if (typeof data === "object") {
      res.push(...data);
    } else {
      res.push(data);
    }
  });
  return res;
}

export function getRequiredEnv(key: string): string {
  const value = process.env[key];
  assert(value, `Please provide ${key} in .env file`);

  return value;
}

export async function getL1ContractAt(hre: any, name: string, address: string) {
  console.log(`Using existing contract: ${name} at: ${address}`);
  const contractFactory = await hre.ethers.getContractFactory(name);
  return contractFactory.attach(address);
}

export async function getL2ContractAt(hre: any, name: string, address: string) {
  console.log(`Using existing contract: ${name} at: ${address}`);
  const contractFactory = await hre.starknet.getContractFactory(name);
  return contractFactory.getContractAt(address);
}

async function transaction(
  txHash: string,
  network: string
) {
  let server;
  if (network === "GOERLI") {
    server = "alpha4.starknet.io";
  } else if (network === "MAINNET") {
    server = "alpha-mainnet.starknet.io";
  } else if (network === "localhost") {
    server = "localhost:5000";
  } else {
    throw new Error(`Cannot query L2 on network ${network}`);
  }
  console.log(`Retrieving transaction ${txHash}`);
  try {
    const url = `https://${server}/feeder_gateway/get_transaction_receipt?transactionHash=${txHash}`;
    const response = await axios.get(url);
    return response.data;
  } catch (err) {
    throw new Error(`Failed getting transaction ${txHash}`);
  }
}

task("flush", "")
  .setAction(async ({}, hre) => {
    const NETWORK = hre.network.name.toUpperCase();
    const l1WormholeGatewayAddress = getRequiredEnv(`${NETWORK}_L1_DAI_WORMHOLE_GATEWAY_ADDRESS`);
    const l2WormholeGatewayAddress = getRequiredEnv(`${NETWORK}_L2_DAI_WORMHOLE_GATEWAY_ADDRESS`);
    const l1WormholeGateway = await getL1ContractAt(hre, "L1DAIWormholeGateway", l1WormholeGatewayAddress);
    const l2WormholeGateway = await getL2ContractAt(hre, "l2_dai_wormhole_gateway", l2WormholeGatewayAddress);

    const accountAddress = getRequiredEnv(`${NETWORK}_L2_ACCOUNT_ADDRESS`);
    const account = await getL2ContractAt(hre, "account", accountAddress);

    const ECDSA_PRIVATE_KEY =
      process.env[`${NETWORK}_ECDSA_PRIVATE_KEY`];
    if (!ECDSA_PRIVATE_KEY) {
      throw new Error(`Set ${NETWORK}_ECDSA_PRIVATE_KEY in .env`);
    }
    const l2Signer = new L2Signer(account, ECDSA_PRIVATE_KEY);

    const domain = getRequiredEnv("DOMAIN");
    const { res: daiToFlushSplit } = await l2WormholeGateway.call("batched_dai_to_flush", { domain });
    const daiToFlush = toUint(daiToFlushSplit);
    console.log(`DAI to flush: ${daiToFlush}`);

    if (daiToFlush > 0 || true) {
      console.log("Sending `flush` transaction");
      const tx = await l2Signer.sendTransaction(
        l2WormholeGateway,
        "flush",
        [domain],
      );

      let state = "PENDING";
      console.log(`Waiting for transaction ${tx} to be accepted on L1`);
      while (state !== "ACCEPTED_ON_L1") {
        state = (await transaction(tx, NETWORK)).status;
      }

      console.log("Sending `finalizeFlush` transaction");
      await l1WormholeGateway.finalizeFlush(toBytes32(domain), daiToFlush);
    }
});
