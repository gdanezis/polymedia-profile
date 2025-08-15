import { WebCryptoSigner } from "@mysten/signers/webcrypto";
import { get, set } from "idb-keyval";

/* WebCrypto Signer and Keypair Management */

const KEYPAIR_STORAGE_KEY = 'polymedia-profile-webcrypto-keypair';

const generateKeypair = async (): Promise<WebCryptoSigner> => {
	// Generate a new WebCrypto signer
	const keypair = await WebCryptoSigner.generate();
	return keypair;
};

const getKeypairFromStorage = async (): Promise<any | null> => {
	try {
		const exportedKeypair = await get(KEYPAIR_STORAGE_KEY);
		// Check if we have a valid exported keypair
		if (exportedKeypair) {
			return exportedKeypair;
		}
		return null;
	} catch (error) {
		console.warn('[getKeypairFromStorage] Failed to read keypair from IndexedDB:', error);
		return null;
	}
};

const saveKeypairToStorage = async (keypair: WebCryptoSigner): Promise<void> => {
	try {
		const exported = keypair.export();
		await set(KEYPAIR_STORAGE_KEY, exported);
		console.debug('[saveKeypairToStorage] Keypair exported and saved to IndexedDB successfully');
	} catch (error) {
		console.warn('[saveKeypairToStorage] Failed to save keypair to IndexedDB:', error);
	}
};

export const initializeKeypair = async (): Promise<WebCryptoSigner> => {
	let exportedKeypair = await getKeypairFromStorage();
	
	if (!exportedKeypair) {
		const newKeypair = await generateKeypair();
		await saveKeypairToStorage(newKeypair);
		const address = newKeypair.getPublicKey().toSuiAddress();
		console.debug('[initializeKeypair] Generated new WebCrypto keypair and saved to IndexedDB with address:', address);
		return newKeypair;
	} else {
		console.debug('[initializeKeypair] Loaded existing keypair from IndexedDB');
	}
	
	try {
		const keypair = await WebCryptoSigner.import(exportedKeypair);
		const address = keypair.getPublicKey().toSuiAddress();
		console.debug('[initializeKeypair] Imported keypair with address:', address);
		return keypair;
	} catch (error) {
		console.warn('[initializeKeypair] Failed to import keypair from storage, generating new one:', error);
		// If the stored keypair is invalid, generate a new one
		const newKeypair = await generateKeypair();
		await saveKeypairToStorage(newKeypair);
		const address = newKeypair.getPublicKey().toSuiAddress();
		console.debug('[initializeKeypair] Generated new WebCrypto keypair with address:', address);
		return newKeypair;
	}
};
