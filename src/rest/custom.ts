// src/rest/custom.ts

import { ethers } from 'ethers';
import { InfoAPI } from './info';
import { ExchangeAPI } from './exchange';
import { UserOpenOrders } from '../types';
import { OrderResponse, CancelOrderRequest, OrderRequest, OrderType } from '../types/index';
import { CancelOrderResponse } from '../utils/signing'
import { SymbolConversion } from '../utils/symbolConversion';
import { floatToWire } from '../utils/signing';

export class CustomOperations {
    private exchange: ExchangeAPI;
    private infoApi: InfoAPI;
    private wallet: ethers.Wallet;
    private symbolConversion: SymbolConversion;
    private walletAddress: string | null;
    private vaultAddress: string | null;

    constructor(exchange: ExchangeAPI, infoApi: InfoAPI, privateKey: string, symbolConversion: SymbolConversion, walletAddress: string | null = null, vaultAddress: string | null = null) {
        this.exchange = exchange;
        this.infoApi = infoApi;
        this.wallet = new ethers.Wallet(privateKey);
        this.symbolConversion = symbolConversion;
        this.walletAddress = walletAddress;
        this.vaultAddress = vaultAddress;
    }

    async cancelAllOrders(symbol?: string): Promise<CancelOrderResponse> {
        try {
            const address = this.vaultAddress || this.walletAddress || this.wallet.address;
            const openOrders: UserOpenOrders = await this.infoApi.getUserOpenOrders(address);

            let ordersToCancel: UserOpenOrders;

            for (let order of openOrders) {
                order.coin = await this.symbolConversion.convertSymbol(order.coin);
            }

            if (symbol) {
                ordersToCancel = openOrders.filter(order => order.coin === symbol);
            } else {
                ordersToCancel = openOrders;
            }

            if (ordersToCancel.length === 0) {
                throw new Error('No orders to cancel');
            }

            const cancelRequests: CancelOrderRequest[] = ordersToCancel.map(order => ({
                coin: order.coin,
                o: order.oid
            }));

            const response = await this.exchange.cancelOrder(cancelRequests);
            return response;
        } catch (error) {
            throw error;
        }
    }

    async getAllAssets(): Promise<{ perp: string[], spot: string[] }> {
        return await this.symbolConversion.getAllAssets();
    }

    private DEFAULT_SLIPPAGE = 0.05;

    private async getSlippagePrice(
        symbol: string,
        isBuy: boolean,
        slippage: number,
        px?: number
    ): Promise<number> {
        const convertedSymbol = await this.symbolConversion.convertSymbol(symbol);
        if (!px) {
            const allMids = await this.infoApi.getAllMids();
            px = Number(allMids[convertedSymbol]);
        }

        const isSpot = symbol.includes("-SPOT");

        //If not isSpot count how many decimals price has to use the same amount for rounding 
        const decimals = px.toString().split('.')[1]?.length || 0;

        px *= isBuy ? (1 + slippage) : (1 - slippage);
        let dec = decimals - 1
        if (dec < 0) {
            dec = 0
        }
        return Number(px.toFixed(isSpot ? 8 : dec));
    }

    async marketOpen(
        symbol: string,
        isBuy: boolean,
        size: number,
        px?: number,
        slippage: number = this.DEFAULT_SLIPPAGE,
        cloid?: string
    ): Promise<OrderResponse> {
        const convertedSymbol = await this.symbolConversion.convertSymbol(symbol);
        try {
            const slippagePrice = await this.getSlippagePrice(convertedSymbol, isBuy, slippage, px);
            const orderRequest: OrderRequest = {
                coin: convertedSymbol,
                is_buy: isBuy,
                sz: size,
                limit_px: slippagePrice,
                order_type: { limit: { tif: 'Ioc' } } as OrderType,
                reduce_only: false
            };
            if (cloid) {
                orderRequest.cloid = cloid;
            }
            return this.exchange.placeOrder(orderRequest);
        } catch (error) {
            console.error('marketOpen error =>', error)
            throw new Error(`marketOpen error ${convertedSymbol}`);
        }
    }

    async marketClose(
        symbol: string,
        size?: number,
        px?: number,
        slippage: number = this.DEFAULT_SLIPPAGE,
        cloid?: string
    ): Promise<OrderResponse> {
        const convertedSymbol = await this.symbolConversion.convertSymbol(symbol);
        try {
            const address = this.vaultAddress || this.walletAddress || this.wallet.address;
            const positions = await this.infoApi.perpetuals.getClearinghouseState(address);
            for (const position of positions.assetPositions) {
                const item = position.position;
                if (convertedSymbol !== item.coin) {
                    continue;
                }
                const szi = parseFloat(item.szi);
                const closeSize = size || Math.abs(szi);
                const isBuy = szi < 0;

                // Get aggressive Market Price
                const slippagePrice = await this.getSlippagePrice(convertedSymbol, isBuy, slippage, px);
                const orderRequest: OrderRequest = {
                    coin: convertedSymbol,
                    is_buy: isBuy,
                    sz: closeSize,
                    limit_px: slippagePrice,
                    order_type: { limit: { tif: 'Ioc' } } as OrderType,
                    reduce_only: true
                };
                if (cloid) {
                    orderRequest.cloid = cloid;
                }

                return this.exchange.placeOrder(orderRequest);
            }
        } catch (error) {
            console.error('marketClose error=>', error)
        }

        throw new Error(`No position found for ${convertedSymbol}`);
    }

    async closeAllPositions(slippage: number = this.DEFAULT_SLIPPAGE): Promise<OrderResponse[]> {
        try {
            const address = this.vaultAddress || this.walletAddress || this.wallet.address;
            const positions = await this.infoApi.perpetuals.getClearinghouseState(address);
            const closeOrders: Promise<OrderResponse>[] = [];

            console.log(positions)

            for (const position of positions.assetPositions) {
                const item = position.position;
                if (parseFloat(item.szi) !== 0) {
                    const symbol = await this.symbolConversion.convertSymbol(item.coin, "forward");
                    closeOrders.push(this.marketClose(symbol, undefined, undefined, slippage));
                }
            }

            return await Promise.all(closeOrders);
        } catch (error) {
            throw error;
        }
    }
}
