package expo.modules.linknet

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Liste les adresses IPv4 locales du téléphone, toutes interfaces confondues
 * (Wi-Fi, partage de connexion, etc.). Sert à afficher l'adresse du boss
 * dans le QR code de synchronisation, y compris quand il partage sa connexion.
 */
class LinkNetModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LinkNet")

    Function("getLocalAddresses") {
      val result = mutableListOf<Map<String, String>>()
      val interfaces = NetworkInterface.getNetworkInterfaces() ?: return@Function result
      for (iface in interfaces.toList()) {
        if (!iface.isUp || iface.isLoopback) continue
        for (addr in iface.inetAddresses.toList()) {
          if (addr is Inet4Address && !addr.isLoopbackAddress) {
            result.add(mapOf("interface" to iface.name, "address" to (addr.hostAddress ?: continue)))
          }
        }
      }
      result
    }
  }
}
