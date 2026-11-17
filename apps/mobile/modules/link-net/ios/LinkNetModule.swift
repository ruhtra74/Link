import ExpoModulesCore
import Darwin

/// Liste les adresses IPv4 locales du téléphone, toutes interfaces confondues
/// (Wi-Fi, partage de connexion, etc.).
public class LinkNetModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LinkNet")

    Function("getLocalAddresses") { () -> [[String: String]] in
      var result: [[String: String]] = []
      var ifaddr: UnsafeMutablePointer<ifaddrs>?
      guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return result }
      defer { freeifaddrs(ifaddr) }

      for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
        let flags = Int32(ptr.pointee.ifa_flags)
        guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0,
              let sa = ptr.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
          result.append(["interface": String(cString: ptr.pointee.ifa_name), "address": String(cString: host)])
        }
      }
      return result
    }
  }
}
